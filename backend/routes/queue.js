const express = require('express');
const Queue = require('../models/Queue');
const Shop = require('../models/Shop');
const { protect, ownerOnly } = require('../middleware/auth');

const router = express.Router();

const calculatePosition = async (shopId) => {
  const lastInQueue = await Queue.findOne({ shopId, status: 'waiting' })
    .sort({ position: -1 })
    .limit(1);
  
  return lastInQueue ? lastInQueue.position + 1 : 1;
};

const calculateEstimatedWait = async (shopId, position) => {
  const shop = await Shop.findById(shopId);
  if (!shop || shop.services.length === 0) return 0;
  
  let totalWait = 0;
  for (let i = 1; i < position; i++) {
    const queueEntry = await Queue.findOne({ shopId, position: i, status: { $in: ['waiting', 'serving'] } });
    if (queueEntry) {
      const service = shop.services.find(s => s.name === queueEntry.service.name);
      totalWait += service ? service.duration : 15;
    }
  }
  
  return totalWait;
};

// /my/queue - must come BEFORE /:id to avoid conflict
router.get('/my/queue', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const myQueue = await Queue.findOne({ 
      userId, 
      status: { $in: ['waiting', 'serving'] }
    })
      .populate('userId', 'name email')
      .populate('shopId', 'name address services location');

    if (!myQueue) {
      return res.status(404).json({ message: 'No active queue' });
    }

    res.json(myQueue);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/join', protect, async (req, res) => {
  try {
    const { shopId, serviceName } = req.body;
    const userId = req.user._id;

    const existingQueue = await Queue.findOne({ 
      userId, 
      shopId,
      status: { $in: ['waiting', 'serving'] }
    });
    
    if (existingQueue) {
      return res.status(400).json({ message: 'Already in queue for this shop' });
    }

    const shop = await Shop.findById(shopId);
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    const service = shop.services.find(s => s.name === serviceName);
    if (!service) {
      return res.status(400).json({ message: 'Service not found' });
    }

    const position = await calculatePosition(shopId);
    const estimatedWait = await calculateEstimatedWait(shopId, position);

    const queueEntry = await Queue.create({
      shopId,
      userId,
      service: { name: serviceName, duration: service.duration },
      position,
      estimatedWait,
      status: 'waiting'
    });

    const populatedQueue = await Queue.findById(queueEntry._id)
      .populate('userId', 'name email')
      .populate('shopId', 'name address');

    req.app.get('io')?.to(`shop:${shopId}`).emit('queue:updated', {
      shopId,
      action: 'joined',
      queue: populatedQueue
    });

    res.status(201).json(populatedQueue);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    
    const queues = await Queue.find({ shopId, status: { $in: ['waiting', 'serving'] } })
      .sort({ position: 1 })
      .populate('userId', 'name email')
      .populate('shopId', 'name address');

    res.json(queues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.patch('/:id/done', protect, ownerOnly, async (req, res) => {
  try {
    const queue = await Queue.findById(req.params.id);
    if (!queue) {
      return res.status(404).json({ message: 'Queue entry not found' });
    }

    queue.status = 'done';
    await queue.save();

    const waitingQueues = await Queue.find({ 
      shopId: queue.shopId, 
      status: 'waiting' 
    }).sort({ position: 1 });

    for (let i = 0; i < waitingQueues.length; i++) {
      waitingQueues[i].position = i + 1;
      const estimatedWait = await calculateEstimatedWait(queue.shopId, i + 1);
      waitingQueues[i].estimatedWait = estimatedWait;
      await waitingQueues[i].save();
    }

    req.app.get('io')?.to(`shop:${queue.shopId}`).emit('customer:done', {
      queueId: queue._id,
      shopId: queue.shopId
    });

    req.app.get('io')?.to(`shop:${queue.shopId}`).emit('queue:updated', {
      shopId: queue.shopId,
      action: 'updated',
      queues: waitingQueues
    });

    res.json({ message: 'Customer marked as done' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Must be registered before DELETE /:id so "owner" is not captured as :id
router.delete('/owner/remove/:id', protect, ownerOnly, async (req, res) => {
  try {
    const queue = await Queue.findById(req.params.id);
    if (!queue) {
      return res.status(404).json({ message: 'Queue entry not found' });
    }

    const shop = await Shop.findById(queue.shopId);
    if (!shop || shop.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const previousPosition = queue.position;
    const userId = queue.userId;
    queue.status = 'cancelled';
    await queue.save();

    const waitingQueues = await Queue.find({ 
      shopId: queue.shopId,
      status: 'waiting',
      position: { $gt: previousPosition }
    }).sort({ position: 1 });

    for (let i = 0; i < waitingQueues.length; i++) {
      waitingQueues[i].position = previousPosition + i;
      const estimatedWait = await calculateEstimatedWait(queue.shopId, previousPosition + i);
      waitingQueues[i].estimatedWait = estimatedWait;
      await waitingQueues[i].save();
    }

    req.app.get('io')?.to(`shop:${queue.shopId}`).emit('queue:updated', {
      shopId: queue.shopId,
      action: 'removed',
      removedByOwner: true
    });

    req.app.get('io')?.to(`user:${userId}`).emit('removed:byOwner', {
      shopId: queue.shopId,
      shopName: shop.name,
      message: 'You have been removed from the queue by the owner'
    });

    res.json({ message: 'Customer removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', protect, async (req, res) => {
  try {
    const queue = await Queue.findById(req.params.id);
    if (!queue) {
      return res.status(404).json({ message: 'Queue entry not found' });
    }

    const queueUserId = (queue.userId && queue.userId._id ? queue.userId._id : queue.userId).toString();
    const reqUserId = req.user._id.toString();

    if (queueUserId !== reqUserId) {
      const shop = await Shop.findById(queue.shopId);
      if (!shop || shop.ownerId.toString() !== reqUserId) {
        return res.status(403).json({ message: 'Not authorized' });
      }
    }

    const previousPosition = queue.position;
    queue.status = 'cancelled';
    await queue.save();

    const waitingQueues = await Queue.find({ 
      shopId: queue.shopId,
      status: 'waiting',
      position: { $gt: previousPosition }
    }).sort({ position: 1 });

    for (let i = 0; i < waitingQueues.length; i++) {
      waitingQueues[i].position = previousPosition + i;
      const estimatedWait = await calculateEstimatedWait(queue.shopId, previousPosition + i);
      waitingQueues[i].estimatedWait = estimatedWait;
      await waitingQueues[i].save();
    }

    req.app.get('io')?.to(`shop:${queue.shopId}`).emit('queue:updated', {
      shopId: queue.shopId,
      action: 'left',
      position: previousPosition
    });

    res.json({ message: 'Left queue successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
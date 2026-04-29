const express = require('express');
const Queue = require('../models/Queue');
const Shop = require('../models/Shop');
const User = require('../models/User');
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

const sendExpoPush = async (tokens, payload) => {
  if (!Array.isArray(tokens) || !tokens.length) return;
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    priority: 'high',
    ...payload,
  }));
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    console.error('[push] failed to send Expo notification:', e.message);
  }
};

const formatTurnEta = (estimatedWaitMinutes) => {
  const mins = Number.isFinite(Number(estimatedWaitMinutes))
    ? Math.max(0, Math.round(Number(estimatedWaitMinutes)))
    : 0;
  const etaDate = new Date(Date.now() + mins * 60 * 1000);
  const etaTime = etaDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return { mins, etaTime };
};

const notifyTurnSoon = async (queueEntry, shopName) => {
  if (!queueEntry || queueEntry.position > 2 || queueEntry.turnSoonNotifiedAt) return;
  const user = await User.findById(queueEntry.userId).select('expoPushTokens');
  const tokens = (user?.expoPushTokens || []).filter((t) => t?.startsWith('ExponentPushToken['));
  if (!tokens.length) return;
  const { mins, etaTime } = formatTurnEta(queueEntry.estimatedWait);

  await sendExpoPush(tokens, {
    title: 'Your turn is coming soon',
    body: `Queue #${queueEntry.position} at ${shopName}. Estimated in ${mins} min (around ${etaTime}). Please be available at the shop.`,
    data: {
      type: 'queue_turn_soon',
      shopId: String(queueEntry.shopId),
      queueId: String(queueEntry._id),
      position: queueEntry.position,
    },
  });

  queueEntry.turnSoonNotifiedAt = new Date();
  await queueEntry.save();
};

const refreshWaitingQueueAndNotify = async (shop, baseShopId) => {
  const waitingQueues = await Queue.find({
    shopId: baseShopId,
    status: 'waiting',
  }).sort({ position: 1 });

  for (let i = 0; i < waitingQueues.length; i++) {
    const entry = waitingQueues[i];
    entry.position = i + 1;
    const estimatedWait = await calculateEstimatedWait(baseShopId, i + 1);
    entry.estimatedWait = estimatedWait;
    await entry.save();
    await notifyTurnSoon(entry, shop?.name || 'your shop');
  }

  return waitingQueues;
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

    // Block user from joining another queue while already active in any shop.
    const existingQueue = await Queue.findOne({
      userId,
      status: { $in: ['waiting', 'serving'] },
    }).populate('shopId', 'name');

    if (existingQueue) {
      const existingShopName = existingQueue.shopId?.name || 'another shop';
      return res.status(400).json({
        message: `You are already in queue at ${existingShopName}`,
        shopName: existingShopName,
      });
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

    await notifyTurnSoon(queueEntry, shop.name);

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

    const shop = await Shop.findById(queue.shopId).select('name');
    const waitingQueues = await refreshWaitingQueueAndNotify(shop, queue.shopId);

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

    await refreshWaitingQueueAndNotify(shop, queue.shopId);

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

    const shop = await Shop.findById(queue.shopId).select('name');
    await refreshWaitingQueueAndNotify(shop, queue.shopId);

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
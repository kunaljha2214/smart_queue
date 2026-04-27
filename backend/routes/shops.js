const express = require('express');
const Shop = require('../models/Shop');
const { protect, ownerOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const shops = await Shop.find().populate('ownerId', 'name email');

    const formattedShops = shops.map(shop => ({
      ...shop.toObject(),
      location: {
        lat: shop.lat,
        lng: shop.lng
      }
    }));

    res.json(formattedShops);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).populate('ownerId', 'name email');
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', protect, ownerOnly, async (req, res) => {
  try {
    const { name, address, lat, lng, services } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and Longitude are required' });
    }

    const shop = await Shop.create({
      name,
      address,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      services: services || [],
      ownerId: req.user._id
    });

    res.status(201).json(shop);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', protect, ownerOnly, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    if (shop.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const { name, address, location, services } = req.body;
    shop.name = name || shop.name;
    shop.address = address || shop.address;
    shop.location = location || shop.location;
    shop.services = services || shop.services;

    await shop.save();
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
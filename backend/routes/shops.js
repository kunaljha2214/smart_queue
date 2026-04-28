const express = require('express');
const Shop = require('../models/Shop');
const { protect, ownerOnly } = require('../middleware/auth');

const router = express.Router();

const toFiniteNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Enforce storage format:
 *   "Service Name - 50₹"
 * even if client sends "Service - ₹50" or "Service - 50$" etc.
 */
const formatServiceNameWithPrice = (rawName, price) => {
  const name = (rawName ?? '').toString().trim();
  if (!name) return '';

  // Remove any existing " - ..." suffix (old price formats) and trim.
  const base = name.split(' - ')[0].trim();
  if (!base) return '';

  // Keep integers if possible, otherwise keep up to 2 decimals.
  const normalizedPrice = Number.isInteger(price) ? String(price) : String(Number(price.toFixed(2)));
  return `${base} - ${normalizedPrice}₹`;
};

const normalizeServices = (input) => {
  if (!Array.isArray(input)) return [];
  return input
    .map((s) => {
      const rawName = (s?.name ?? '').toString().trim();
      const price = toFiniteNumber(s?.price);
      const duration = toFiniteNumber(s?.duration);
      if (!rawName) return null;
      if (price === null || price <= 0) return null;
      if (duration === null || duration <= 0) return null;

      return {
        name: formatServiceNameWithPrice(rawName, price),
        price,
        duration,
      };
    })
    .filter(Boolean);
};

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
      services: normalizeServices(services),
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

    const { name, address, lat, lng, location, services } = req.body;
    shop.name = name || shop.name;
    shop.address = address || shop.address;
    if (lat !== undefined && lat !== null) {
      const parsedLat = Number(lat);
      if (Number.isFinite(parsedLat)) shop.lat = parsedLat;
    }
    if (lng !== undefined && lng !== null) {
      const parsedLng = Number(lng);
      if (Number.isFinite(parsedLng)) shop.lng = parsedLng;
    }
    // Backward-compatible fallback if caller sends location object.
    if (location && typeof location === 'object') {
      const parsedLat = Number(location.lat);
      const parsedLng = Number(location.lng);
      if (Number.isFinite(parsedLat)) shop.lat = parsedLat;
      if (Number.isFinite(parsedLng)) shop.lng = parsedLng;
    }
    if (services) {
      shop.services = normalizeServices(services);
    }

    await shop.save();
    res.json(shop);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
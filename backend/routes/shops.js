const express = require('express');
const Shop = require('../models/Shop');
const { protect, ownerOnly } = require('../middleware/auth');
const Razorpay = require('razorpay');

const router = express.Router();
const MONTHLY_CHARGE = 300;
const RAZORPAY_AMOUNT_PAISE = MONTHLY_CHARGE * 100;

const isShopSubscriptionValid = (shop) => {
  const isActive = Boolean(shop?.subscription?.isActive);
  const due = shop?.subscription?.nextDueAt ? new Date(shop.subscription.nextDueAt) : null;
  if (!isActive || !due) return false;
  return due.getTime() > Date.now();
};

const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

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
    const visibleShops = shops.filter((shop) => isShopSubscriptionValid(shop));

    const formattedShops = visibleShops.map(shop => ({
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

router.get('/mine/list', protect, ownerOnly, async (req, res) => {
  try {
    const shops = await Shop.find({ ownerId: req.user._id }).populate('ownerId', 'name email');
    const formattedShops = shops.map((shop) => ({
      ...shop.toObject(),
      location: {
        lat: shop.lat,
        lng: shop.lng,
      },
      subscription: {
        ...(shop.subscription || {}),
        isActive: isShopSubscriptionValid(shop),
      },
    }));
    res.json(formattedShops);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id/subscription/status', protect, ownerOnly, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }
    if (shop.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    res.json({
      isActive: isShopSubscriptionValid(shop),
      monthlyCharge: shop.subscription?.monthlyCharge || MONTHLY_CHARGE,
      lastPaidAt: shop.subscription?.lastPaidAt || null,
      nextDueAt: shop.subscription?.nextDueAt || null,
      lastPaymentId: shop.subscription?.lastPaymentId || null,
      lastPaymentStatus: shop.subscription?.lastPaymentStatus || null,
      pendingPaymentLinkId: shop.subscription?.pendingPaymentLinkId || null,
      pendingPaymentLinkUrl: shop.subscription?.pendingPaymentLinkUrl || null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/subscription/create-payment-link', protect, ownerOnly, async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }
    if (shop.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const razorpay = getRazorpayClient();
    const paymentLink = await razorpay.paymentLink.create({
      amount: RAZORPAY_AMOUNT_PAISE,
      currency: 'INR',
      accept_partial: false,
      description: `Smart Queue monthly subscription for ${shop.name}`,
      customer: {
        name: req.user.name || 'Shop Owner',
        email: req.user.email,
      },
      notify: {
        sms: false,
        email: true,
      },
      notes: {
        shopId: shop._id.toString(),
        ownerId: req.user._id.toString(),
        plan: 'monthly_300',
      },
    });

    shop.subscription = {
      ...(shop.subscription || {}),
      monthlyCharge: MONTHLY_CHARGE,
      pendingPaymentLinkId: paymentLink.id,
      pendingPaymentLinkUrl: paymentLink.short_url || paymentLink.url || null,
      lastPaymentStatus: 'created',
    };
    await shop.save();

    res.json({
      message: 'Payment link created',
      paymentLinkId: paymentLink.id,
      paymentLinkUrl: paymentLink.short_url || paymentLink.url,
      amount: MONTHLY_CHARGE,
      currency: 'INR',
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
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
      subscription: {
        isActive: false,
        monthlyCharge: MONTHLY_CHARGE,
        lastPaidAt: null,
        nextDueAt: null,
      },
      ownerId: req.user._id
    });

    res.status(201).json(shop);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/pay-subscription', protect, ownerOnly, async (req, res) => {
  return res.status(410).json({
    message: 'Legacy endpoint removed. Use /subscription/create-payment-link for real payment.',
  });
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
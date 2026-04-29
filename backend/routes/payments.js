const crypto = require('crypto');
const express = require('express');
const Shop = require('../models/Shop');

const router = express.Router();
const MONTHLY_CHARGE = 300;

const addOneMonth = (date) => {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + 1);
  return next;
};

router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).json({ message: 'Webhook secret not configured' });
    }

    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body)
      .digest('hex');

    if (signature !== expected) {
      return res.status(400).json({ message: 'Invalid webhook signature' });
    }

    const payload = JSON.parse(req.body.toString('utf8'));
    const event = payload?.event;
    const paymentLink = payload?.payload?.payment_link?.entity;
    const payment = payload?.payload?.payment?.entity;
    const paymentLinkId = paymentLink?.id;

    if (!paymentLinkId) {
      return res.json({ message: 'No payment link id in webhook' });
    }

    const shop = await Shop.findOne({ 'subscription.pendingPaymentLinkId': paymentLinkId });
    if (!shop) {
      return res.json({ message: 'No matching shop for payment link' });
    }

    if (event === 'payment_link.paid') {
      const now = new Date();
      const baseDate =
        shop.subscription?.nextDueAt && new Date(shop.subscription.nextDueAt) > now
          ? new Date(shop.subscription.nextDueAt)
          : now;
      shop.subscription = {
        ...(shop.subscription || {}),
        isActive: true,
        monthlyCharge: MONTHLY_CHARGE,
        lastPaidAt: now,
        nextDueAt: addOneMonth(baseDate),
        lastPaymentId: payment?.id || null,
        lastPaymentStatus: 'paid',
        pendingPaymentLinkId: null,
        pendingPaymentLinkUrl: null,
      };
      await shop.save();
      return res.json({ message: 'Subscription activated' });
    }

    if (event === 'payment_link.cancelled' || event === 'payment.failed') {
      shop.subscription = {
        ...(shop.subscription || {}),
        lastPaymentStatus: event,
      };
      await shop.save();
      return res.json({ message: 'Payment status updated' });
    }

    return res.json({ message: 'Webhook received' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;

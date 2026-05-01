/**
 * Subscription: active flag and nextDueAt in the future.
 * Public list + queue joins also require the owner to mark the shop open.
 */

const isShopSubscriptionValid = (shop) => {
  const isActive = Boolean(shop?.subscription?.isActive);
  const due = shop?.subscription?.nextDueAt ? new Date(shop.subscription.nextDueAt) : null;
  if (!isActive || !due) return false;
  return due.getTime() > Date.now();
};

/** Shown in customer shop list and allows new joins. */
const isShopVisibleToCustomers = (shop) =>
  isShopSubscriptionValid(shop) && shop?.isOpen !== false;

module.exports = {
  isShopSubscriptionValid,
  isShopVisibleToCustomers,
};

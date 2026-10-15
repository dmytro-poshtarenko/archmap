import { Meteor } from "meteor/meteor";

Meteor.methods({
  async "orders.cancel"(orderId: string) {
    return { orderId, cancelled: true };
  },
});

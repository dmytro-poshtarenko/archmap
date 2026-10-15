import { Meteor } from "meteor/meteor";

export function cancelOrder(orderId: string) {
  return Meteor.callAsync("orders.cancel", orderId);
}

/*

BONUS! QUICK START FOR DEVELOPERS

This is a quick boilerplate for Meshtastic Web javascritp library input and output.
It is not used by Node-RED module but could help you to understand how to use the library.

Daniel B.P. (www.danbp.org)
11/11/2025


How to run:

  npm install @mesthastic/transport-http
  node ./fundamentals_meshtastic_web.mjs

*/

// Import the required libraries
// To install the NPM packages, use "npm install @meshtastic/transport-http", the core package will come as a requirement
import { MeshDevice } from "@meshtastic/core";
import { TransportHTTP } from "@meshtastic/transport-http";

//Minimum settings
let ip = "meshtastic.local";
let fetchInterval = 5000;
let tls = false;

try {
  const transport = await TransportHTTP.create(ip, tls);
  transport.fetchInterval = fetchInterval;
  const device = await new MeshDevice(transport);

  //Get the device the configuration
  //device.configure()

  // Subscribes to an event (onMessagePacket) and prints the received message
  device.events.onMessagePacket.subscribe(function (message) {
    //Execute when a message was received
    console.log(">>>>> RECEIVED A MESSAGE >>>>> " + message.data);
  });

  //Subscribe to the device status
  device.events.onDeviceStatus.subscribe(function (status) {
    console.log(">>>>> STATUS CODE >>>>> " + status);

    if (status == 5) {
      //Wait for the connected status (5)

      console.log(">>>>> SENDING MESSAGE NOW >>>>> ");

      //Test message (sent every time the device status changes to online)
      let message = "I am alive!!";
      let destination = "broadcast"; //4294967295
      let wantAck = false;
      let channel = 0;
      device
        .sendText(message, destination, wantAck, channel)
        .then((id) => {
          console.log(">>>>> MESSAGE SENT >>>>> " + message);
        })
        .catch((e) => {
          console.log(">>>>> ERROR SENDING MESSAGE >>>>> " + e);
        });
    }
  });

  // Use this to disconnect from the device
  //device.disconnect();
} catch (error) {
  console.log(error);
}

# Node-RED Meshtastic Messages Node

This node allows sending and receiving packets to a Meshtastic mesh network thru a device connected via HTTP. It is based on [Meshtastic.js](https://js.meshtastic.org/) library.

## Features
- Send and receive text messages
- Supervise device status
- Subscribe and receive all types of events supported by Meshtastic.js (examples: Atak, Position, Range Test, Map Report, Store and Forward, etc...)
- Send a generic package to any application

## What it does not do
- Connect via MQTT as this is not supported by Meshtastic.js
- Connect to a device via Bluetooth or Serial (not implemented yet)
- Connect to a Lora mesh without a physical device/radio (people asked that!)

## Manual installation
- Add the project files to a folder called `node-red-meshtastic-msg` inside the Node-RED base directory (where the `settings.js` is located)
- Run `npm install ./node-red-meshtastic-msg`
- To uninstall, run `npm remove @danpeig/node-red-meshtastic-msg` from the same base directory.

## Automatic installation
- Search for the package `@danpeig/node-red-meshtastic-msg` in the Node-RED community catalogue or NPM.

## Known issues
Meshtastic.js library has many bugs and can crash your Node-RED server in the following known circumstances:
1. Connection interrupted during initialization can cause an infinite loop.
2. Sending a packet with `wantResponse` flag set to `true`

## Examples
An example flow with the acceptable input message formats can be found in the `examples` sub-directory.

## Bonus
The `experiments_meshtastic.js` illustrates how to use the Meshtastic.js library from plain Javascript (No TS, no react, no nothing).

## License
This node was created by [Daniel BP](http://www.danbp.org) ans is available under the MIT license.

----
# Reference guide

## Send text node
Send a text message to the mesh connected device

### Input
- payload (string) :  the text message to be sent to the network
- *channel* (integer):  the Meshtastic channel number. Defaults to 0 (primary)
- *destination* (integer):  the destination node number. Defaults to 4294967295 (broadcast)
- *wantAck* (boolean):  if the receiving devices should acknowldege receipt. Defaults to true

*italic* = optional fields

## Receive text node
Receive a text message from the mesh connected device

### Outputs
- msg (json) : object with all package properties
- msg.payload (string): text content of the message 

## Receive status node
Receive the status code of the Meshtastic device
    
### Outputs
    
- msg.payload (integer): status code of the device

## Receive event node
This node will watch for the defined event and output the payload received.
Typically, the output should be a JSON field but there are some events that report numbers or simple strings.
The events list comes from Mesthastic.js [Event System Class](https://js.meshtastic.org/classes/Utils.EventSystem.html)

### Settings
- event (string): select the event to monitor/watch

### Outputs
- msg (json): data from the event

## Send packet node
Send a packet to the mesh connected device.
Input packet can be either in the string format (*msg.payload*) or Uint8Array (*msg.byteData*) format.

### Input

- payload (string): Will be converted to Uint8Array and used if *byteData* field is not set
- *byteData* (json) : Data properly encoded as Uint8Array. If set, will be used instead of *payload*. Example [72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33]
- *portNum* (integer): Application number. Defaults to 1 (text messsage).
- *destination* (integer string): Destination node. Can be a number, "broadcast" or "self".
- *channel* (integer): Channel number, defaults to 0 (primary)
- *wantAck* (boolean):  Confirmation, defaults to true
- *wantResponse* (boolean): Defaults to false.
- *echoResponse* (boolean): Defaults to false
- *replyId* (integer): Defaults to null
- *emoji* (integer): Defaults to null

*italic* = optional fields

## Device configuration node
This will setup the connection to the Meshtastic node.
The connection protocol is HTTP. Serial, Bluetooth or MQTT are not supported.

### Options
* IP or hostname (string) : IP address or hostname of the Meshtastic device to connect. Examples: *192.168.0.15*, *meshtastic.local*
* Use TLS (boolean): If true, the connection will be performed using TLS (encrypted). Default is false as most of the devices are not configured for it. 
* Fetch interval (integer): Interval between polling data from the device. Default is 5000ms.
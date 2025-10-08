const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8080';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';
// MQTT Configuration
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';// ======= WEBSOCKET CONNECTION =======
let ws = null;
function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log(':white_check_mark: WebSocket connected to RVM');
  });
  ws.on('message', (data) => {
    try {
      console.log(':envelope_with_arrow: Raw WebSocket message:', data.toString());
      const message = JSON.parse(data);
      console.log(':envelope_with_arrow: Parsed RVM Event:', JSON.stringify(message, null, 2));
      // Check if message has expected structure
      if (!message.function && !message.data) {
        console.log(':warning: Message missing function or data fields');
        return;
      }
      // Publish RVM events to MQTT
      const eventTopic = `rvm/${DEVICE_ID}/events`;
      const payload = {
        deviceId: DEVICE_ID,
        function: message.function || 'unknown',
        data: message.data || message,
        timestamp: new Date().toISOString()
      };
      mqttClient.publish(eventTopic, JSON.stringify(payload), (err) => {
        if (err) {
          console.error(':x: Failed to publish event:', err.message);
        } else {
          console.log(':outbox_tray: Event published to MQTT');
        }
      });
      // Log specific events
      if (message.function === 'aiPhoto') {
        console.log(':robot_face: AI Detection:', message.data);
      } else if (message.function === 'deviceStatus') {
        console.log(':package: Bin Status:', message.data);
      } else if (message.function === '03') {
        console.log(':warning: Device Error:', message.data);
      } else if (message.function === '06') {
        console.log(':scales: Weight Event:', message.data);
      } else if (message.function === 'qrcode') {
        console.log(':mag: QR Code Scanned:', message.data);
      }
    } catch (err) {
      console.error(':x: WebSocket parse error:', err.message);
      console.error('Raw data:', data.toString());
    }
  });
  ws.on('close', () => {
    console.log(':warning: WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  ws.on('error', (err) => {
    console.error(':x: WebSocket error:', err.message);
  });
}
// ======= MQTT CLIENT =======
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ca: fs.readFileSync(MQTT_CA_FILE),
  rejectUnauthorized: false
});
mqttClient.on('connect', () => {
  console.log(':white_check_mark: Connected to MQTT Broker');
  // Subscribe to commands for this device
  const commandTopic = `rvm/${DEVICE_ID}/commands`;
  mqttClient.subscribe(commandTopic, (err) => {
    if (!err) {
      console.log(`:satellite_antenna: Subscribed to: ${commandTopic}`);
    } else {
      console.error(':x: Subscribe error:', err.message);
    }
  });
  // Start WebSocket connection after MQTT is ready
  connectWebSocket();
});
// ======= HANDLE MQTT COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log(`:envelope_with_arrow: MQTT Command received: ${message.toString()}`);
  try {
    const command = JSON.parse(message.toString());
    let result;
    if (command.action === 'openGate') {
      console.log(':door: Opening gate...');
      // Call local RVM API to open gate
      result = await axios.post(`${LOCAL_API_BASE}/system/serial/motorSelect`, {
        moduleId: '05',
        motorId: '01',
        type: '03',
        deviceType: 1
      });
      console.log(':white_check_mark: Gate opened successfully');
    } else if (command.action === 'closeGate') {
      console.log(':door: Closing gate...');
      // Call local RVM API to close gate
      result = await axios.post(`${LOCAL_API_BASE}/system/serial/motorSelect`, {
        moduleId: '05',
        motorId: '01',
        type: '00',
        deviceType: 1
      });
      console.log(':white_check_mark: Gate closed successfully');
    } else {
      console.log(':warning: Unknown command:', command.action);
      // Send error response for unknown command
      const responseTopic = `rvm/${DEVICE_ID}/responses`;
      mqttClient.publish(responseTopic, JSON.stringify({
        command: command.action,
        success: false,
        error: 'Unknown command',
        timestamp: new Date().toISOString()
      }));
      return;
    }
    // Send success response back
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: command.action,
      success: true,
      result: result.data,
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    console.error(':x: Command execution error:', err.message);
    // Send error response
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: message.toString(),
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }));
  }
});
mqttClient.on('error', (err) => {
  console.error(':x: MQTT error:', err.message);
});
mqttClient.on('reconnect', () => {
  console.log(':arrows_counterclockwise: Reconnecting to MQTT...');
});
process.on('SIGINT', () => {
  console.log('\n:black_square_for_stop: Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});
console.log('========================================');
console.log(':rocket: RVM Agent Started');
console.log('========================================');
console.log(`:iphone: Device ID: ${DEVICE_ID}`);
console.log(`:electric_plug: Local API: ${LOCAL_API_BASE}`);
console.log(`:speech_balloon: WebSocket: ${WS_URL}`);
console.log('========================================');
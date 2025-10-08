const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';  // Same port as WebSocket
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';
// MQTT Configuration
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';
// Store pending commands to match with WebSocket responses
const pendingCommands = new Map();
// ======= WEBSOCKET CONNECTION =======
let ws = null;
function connectWebSocket() {
  console.log(`:electric_plug: Attempting to connect to WebSocket: ${WS_URL}`);
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log(':white_check_mark: WebSocket connected to RVM');
  });
  ws.on('message', (data) => {
    try {
      console.log('\n:envelope_with_arrow: Raw WebSocket message:', data.toString());
      const message = JSON.parse(data);
      console.log(':envelope_with_arrow: Parsed WebSocket message:', JSON.stringify(message, null, 2));
      // Publish all WebSocket events to MQTT
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
      // Check if this is a response to a pending command
      if (pendingCommands.size > 0) {
        const [commandId, commandData] = Array.from(pendingCommands.entries())[0];
        console.log(`:white_check_mark: Received response for command: ${commandData.action}`);
        // Send response back to MQTT
        const responseTopic = `rvm/${DEVICE_ID}/responses`;
        mqttClient.publish(responseTopic, JSON.stringify({
          command: commandData.action,
          success: true,
          result: message,
          timestamp: new Date().toISOString()
        }));
        pendingCommands.delete(commandId);
      }
      // Log specific events
      if (message.function === 'aiPhoto') {
        console.log(':robot_face: AI Detection Result:', message.data);
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
  // Start WebSocket connection
  console.log('\n:electric_plug: Starting WebSocket connection...');
  connectWebSocket();
});
// ======= HANDLE MQTT COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log('\n========================================');
  console.log(`:envelope_with_arrow: MQTT Command received on topic: ${topic}`);
  console.log(`:incoming_envelope: Raw message: ${message.toString()}`);
  try {
    const command = JSON.parse(message.toString());
    console.log(`:clipboard: Parsed command:`, JSON.stringify(command, null, 2));
    let apiUrl;
    let apiPayload;
    if (command.action === 'openGate') {
      console.log(':door: Processing: Open Gate');
      console.log(':book: Doc Reference: Section 5.1 - Gate Motor Open Gate');
      apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: '05',  // Module Code
        motorId: '01',   // Gate Motor
        type: '03',      // End location (open position)
        deviceType: 1    // RVM-3101
      };
    } else if (command.action === 'closeGate') {
      console.log(':door: Processing: Close Gate');
      console.log(':book: Doc Reference: Section 5.2 - Gate Motor Close Gate');
      apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: '05',  // Module Code
        motorId: '01',   // Gate Motor
        type: '00',      // Moving/start location (close position)
        deviceType: 1    // RVM-3101
      };
    } else {
      console.log(':warning: Unknown command:', command.action);
      const responseTopic = `rvm/${DEVICE_ID}/responses`;
      mqttClient.publish(responseTopic, JSON.stringify({
        command: command.action,
        success: false,
        error: 'Unknown command',
        timestamp: new Date().toISOString()
      }));
      console.log('========================================\n');
      return;
    }
    // Make API call to local RVM
    console.log(`:link: Calling RVM API: ${apiUrl}`);
    console.log(`:package: Request payload:`, JSON.stringify(apiPayload, null, 2));
    try {
      const result = await axios.post(apiUrl, apiPayload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      console.log(`:white_check_mark: RVM API Response Status: ${result.status}`);
      console.log(`:inbox_tray: RVM API Response:`, JSON.stringify(result.data, null, 2));
      console.log(`:white_check_mark: Command sent to RVM hardware`);
      console.log(`:hourglass_flowing_sand: Waiting for WebSocket response...`);
      // Store command as pending
      const commandId = Date.now().toString();
      pendingCommands.set(commandId, {
        action: command.action,
        timestamp: new Date().toISOString()
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (pendingCommands.has(commandId)) {
          console.log(`:warning: Timeout waiting for WebSocket response for: ${command.action}`);
          pendingCommands.delete(commandId);
          const responseTopic = `rvm/${DEVICE_ID}/responses`;
          mqttClient.publish(responseTopic, JSON.stringify({
            command: command.action,
            success: false,
            error: 'Timeout waiting for hardware response',
            timestamp: new Date().toISOString()
          }));
        }
      }, 10000);
    } catch (apiError) {
      console.error('\n:x: RVM API Call Failed!');
      console.error(`   Error Type: ${apiError.code || 'Unknown'}`);
      console.error(`   Error Message: ${apiError.message}`);
      if (apiError.response) {
        console.error(`   HTTP Status: ${apiError.response.status}`);
        console.error(`   Response Data:`, apiError.response.data);
      } else if (apiError.request) {
        console.error('   :warning: No response received from RVM API');
        console.error('   Possible reasons:');
        console.error('   1. RVM middleware is not running on port 8081');
        console.error('   2. Incorrect URL or endpoint');
        console.error('   3. Firewall blocking the connection');
        console.error('   4. RVM service crashed or stopped');
        console.error('\n   :bulb: Solution:');
        console.error('   - Check if RVM middleware is running');
        console.error('   - Verify port 8081 is correct');
        console.error('   - Test with: curl -X POST http://localhost:8081/system/serial/motorSelect');
      }
      // Send error response
      const responseTopic = `rvm/${DEVICE_ID}/responses`;
      mqttClient.publish(responseTopic, JSON.stringify({
        command: command.action,
        success: false,
        error: apiError.message,
        errorDetails: {
          code: apiError.code,
          syscall: apiError.syscall,
          address: apiError.address,
          port: apiError.port
        },
        timestamp: new Date().toISOString()
      }));
      console.log(':outbox_tray: Error response published to MQTT');
    }
  } catch (err) {
    console.error(':x: Command parsing error:', err.message);
  }
  console.log('========================================\n');
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
console.log(`:electric_plug: RVM API & WebSocket: localhost:8081`);
console.log(`   - HTTP API: ${LOCAL_API_BASE}`);
console.log(`   - WebSocket: ${WS_URL}`);
console.log(`:link: MQTT Broker: ${MQTT_BROKER_URL}`);
console.log('========================================');
console.log('\n:book: RVM API Endpoints (Port 8081):');
console.log('   - Gate Open:  POST /system/serial/motorSelect');
console.log('   - Gate Close: POST /system/serial/motorSelect');
console.log('   - WebSocket:  ws://localhost:8081/websocket/qazwsx1234');
console.log('========================================\n');







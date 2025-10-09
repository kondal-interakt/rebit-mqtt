const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIGURATION =======
const DEVICE_ID = 'RVM-3101';
const LOCAL_API_BASE = 'http://localhost:8081';
const WS_URL = 'ws://localhost:8081/websocket/qazwsx1234';

// MQTT Configuration
const MQTT_BROKER_URL = 'mqtts://mqtt.ceewen.xyz:8883';
const MQTT_USERNAME = 'mqttuser';
const MQTT_PASSWORD = 'mqttUser@2025';
const MQTT_CA_FILE = 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle';
// ======= WEBSOCKET CONNECTION =======
let ws = null;

function connectWebSocket() {
  console.log(`🔌 Attempting to connect to WebSocket: ${WS_URL}`);
  
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected to RVM');
  });
  
  ws.on('message', (data) => {
    try {
      console.log('\n📩 Raw WebSocket message:', data.toString());
      
      const message = JSON.parse(data);
      console.log('📩 Parsed WebSocket message:', JSON.stringify(message, null, 2));
      
      // Skip connection success message
      if (message.msg === '连接成功' || message.msg === 'connection successful') {
        console.log('✅ WebSocket connection confirmed');
        return;
      }
      
      // Publish WebSocket events to MQTT
      const eventTopic = `rvm/${DEVICE_ID}/events`;
      const payload = {
        deviceId: DEVICE_ID,
        function: message.function || 'unknown',
        data: message.data || message,
        rawMessage: message,
        timestamp: new Date().toISOString()
      };
      
      mqttClient.publish(eventTopic, JSON.stringify(payload), (err) => {
        if (err) {
          console.error('❌ Failed to publish event:', err.message);
        } else {
          console.log('📤 Event published to MQTT');
        }
      });
      
      // Log specific events based on function type
      if (message.function === 'aiPhoto') {
        console.log('🤖 AI Detection Result:', message.data);
      } else if (message.function === 'deviceStatus') {
        console.log('📦 Bin Status:', message.data);
      } else if (message.function === '03') {
        console.log('⚠️ Device Error:', message.data);
      } else if (message.function === '06') {
        console.log('⚖️ Weight Event:', message.data);
      } else if (message.function === 'qrcode') {
        console.log('🔍 QR Code Scanned:', message.data);
      } else {
        console.log('📨 Other Event:', message.function || 'unknown');
      }
      
    } catch (err) {
      console.error('❌ WebSocket parse error:', err.message);
      console.error('Raw data:', data.toString());
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
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
  console.log('✅ Connected to MQTT Broker');
  
  // Subscribe to commands for this device
  const commandTopic = `rvm/${DEVICE_ID}/commands`;
  mqttClient.subscribe(commandTopic, (err) => {
    if (!err) {
      console.log(`📡 Subscribed to: ${commandTopic}`);
    } else {
      console.error('❌ Subscribe error:', err.message);
    }
  });
  
  // Start WebSocket connection
  console.log('\n🔌 Starting WebSocket connection...');
  connectWebSocket();
});

// ======= HANDLE MQTT COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log('\n========================================');
  console.log(`📩 MQTT Command received on topic: ${topic}`);
  console.log(`📨 Raw message: ${message.toString()}`);
  
  try {
    const command = JSON.parse(message.toString());
    console.log(`📋 Parsed command:`, JSON.stringify(command, null, 2));
    
    let apiUrl;
    let apiPayload;
    
    if (command.action === 'openGate') {
      console.log('🚪 Processing: Open Gate');
      console.log('📖 Doc Reference: Section 5.1 - Gate Motor Open Gate');
      apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: '05',
        motorId: '01',
        type: '03',
        deviceType: 1
      };
      
    } else if (command.action === 'closeGate') {
      console.log('🚪 Processing: Close Gate');
      console.log('📖 Doc Reference: Section 5.2 - Gate Motor Close Gate');
      apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: '05',
        motorId: '01',
        type: '00',
        deviceType: 1
      };
      
    } else {
      console.log('⚠️ Unknown command:', command.action);
      
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
    console.log(`🔗 Calling RVM API: ${apiUrl}`);
    console.log(`📦 Request payload:`, JSON.stringify(apiPayload, null, 2));
    
    try {
      const result = await axios.post(apiUrl, apiPayload, {
        timeout: 10000,
        headers: {
          'Content-Type': application/json'
        }
      });
      
      console.log(`✅ RVM API Response Status: ${result.status}`);
      console.log(`📥 RVM API Response:`, JSON.stringify(result.data, null, 2));
      
      // Check if response indicates success
      if (result.status === 200 && result.data.code === 200) {
        console.log(`✅ ${command.action} executed successfully`);
        console.log(`📡 Hardware command: ${result.data.data.cmd}`);
        
        // Send success response immediately (don't wait for WebSocket)
        const responseTopic = `rvm/${DEVICE_ID}/responses`;
        const responsePayload = {
          command: command.action,
          success: true,
          result: {
            status: result.status,
            code: result.data.code,
            message: result.data.msg,
            hardwareCommand: result.data.data.cmd,
            details: result.data.data.message
          },
          timestamp: new Date().toISOString()
        };
        
        mqttClient.publish(responseTopic, JSON.stringify(responsePayload), (err) => {
          if (err) {
            console.error('❌ Failed to publish response:', err.message);
          } else {
            console.log('📤 Success response published to MQTT');
          }
        });
        
      } else {
        console.log('⚠️ Unexpected response format');
        
        const responseTopic = `rvm/${DEVICE_ID}/responses`;
        mqttClient.publish(responseTopic, JSON.stringify({
          command: command.action,
          success: false,
          error: 'Unexpected API response',
          result: result.data,
          timestamp: new Date().toISOString()
        }));
      }
      
    } catch (apiError) {
      console.error('\n❌ RVM API Call Failed!');
      console.error(`   Error Type: ${apiError.code || 'Unknown'}`);
      console.error(`   Error Message: ${apiError.message}`);
      
      if (apiError.response) {
        console.error(`   HTTP Status: ${apiError.response.status}`);
        console.error(`   Response Data:`, apiError.response.data);
      } else if (apiError.request) {
        console.error('   ⚠️ No response received from RVM API');
        console.error('   Possible reasons:');
        console.error('   1. RVM middleware is not running on port 8081');
        console.error('   2. Incorrect URL or endpoint');
        console.error('   3. Firewall blocking the connection');
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
      
      console.log('📤 Error response published to MQTT');
    }
    
  } catch (err) {
    console.error('❌ Command parsing error:', err.message);
  }
  
  console.log('========================================\n');
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('🔄 Reconnecting to MQTT...');
});

process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (ws) ws.close();
  mqttClient.end();
  process.exit(0);
});

console.log('========================================');
console.log('🚀 RVM Agent Started');
console.log('========================================');
console.log(`📱 Device ID: ${DEVICE_ID}`);
console.log(`🔌 RVM API & WebSocket: localhost:8081`);
console.log(`   - HTTP API: ${LOCAL_API_BASE}`);
console.log(`   - WebSocket: ${WS_URL}`);
console.log(`🔗 MQTT Broker: ${MQTT_BROKER_URL}`);
console.log('========================================');
console.log('\n📖 Operation Mode:');
console.log('   - Commands sent via HTTP API');
console.log('   - Success response sent immediately when API returns 200');
console.log('   - WebSocket monitors for events (AI, weight, bin status, etc)');
console.log('========================================\n');
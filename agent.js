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

// Store moduleId from getModuleId response
let currentModuleId = null;
let pendingCommands = new Map();

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
      
      // Handle getModuleId response (function: "01")
      if (message.function === '01') {
        currentModuleId = message.moduleId;
        console.log(`✅ Module ID received: ${currentModuleId}`);
        console.log(`📋 Device Serial: ${message.data}`);
        console.log(`🔌 COM Port: ${message.comId}`);
        
        // Check if there's a pending command waiting for moduleId
        if (pendingCommands.size > 0) {
          const [commandId, commandData] = Array.from(pendingCommands.entries())[0];
          console.log(`🔄 Executing pending command: ${commandData.action}`);
          executePendingCommand(commandData);
          pendingCommands.delete(commandId);
        }
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
      
      // Log specific events
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

// ======= GET MODULE ID =======
async function getModuleId() {
  try {
    console.log('🔍 Getting Module ID...');
    const result = await axios.post(`${LOCAL_API_BASE}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📥 getModuleId HTTP Response:', JSON.stringify(result.data, null, 2));
    console.log('⏳ Waiting for WebSocket response with function: "01"...');
    
    return result.data;
  } catch (err) {
    console.error('❌ Failed to get module ID:', err.message);
    throw err;
  }
}

// ======= EXECUTE PENDING COMMAND =======
async function executePendingCommand(commandData) {
  const { action, originalCommand } = commandData;
  
  let apiUrl;
  let apiPayload;
  
  if (!currentModuleId) {
    console.error('❌ No moduleId available!');
    return;
  }
  
  if (action === 'openGate') {
    console.log('🚪 Processing: Open Gate');
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: currentModuleId,  // Use dynamic moduleId from getModuleId
      motorId: '01',
      type: '03',
      deviceType: 1
    };
    
  } else if (action === 'closeGate') {
    console.log('🚪 Processing: Close Gate');
    apiUrl = `${LOCAL_API_BASE}/system/serial/motorSelect`;
    apiPayload = {
      moduleId: currentModuleId,  // Use dynamic moduleId from getModuleId
      motorId: '01',
      type: '00',
      deviceType: 1
    };
  }
  
  console.log(`🔗 Calling RVM API: ${apiUrl}`);
  console.log(`📦 Request payload (with moduleId ${currentModuleId}):`, JSON.stringify(apiPayload, null, 2));
  
  try {
    const result = await axios.post(apiUrl, apiPayload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`✅ RVM API Response Status: ${result.status}`);
    console.log(`📥 RVM API Response:`, JSON.stringify(result.data, null, 2));
    
    if (result.status === 200 && result.data.code === 200) {
      console.log(`✅ ${action} executed successfully`);
      console.log(`📡 Hardware command: ${result.data.data.cmd}`);
      
      // Send success response
      const responseTopic = `rvm/${DEVICE_ID}/responses`;
      const responsePayload = {
        command: action,
        success: true,
        result: {
          status: result.status,
          code: result.data.code,
          message: result.data.msg,
          hardwareCommand: result.data.data.cmd,
          moduleId: currentModuleId,
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
    }
    
  } catch (apiError) {
    console.error('\n❌ RVM API Call Failed!');
    console.error(`   Error: ${apiError.message}`);
    
    const responseTopic = `rvm/${DEVICE_ID}/responses`;
    mqttClient.publish(responseTopic, JSON.stringify({
      command: action,
      success: false,
      error: apiError.message,
      timestamp: new Date().toISOString()
    }));
  }
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
  
  // Subscribe to commands
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
  
  // Get moduleId on startup after WebSocket connects
  setTimeout(async () => {
    try {
      await getModuleId();
    } catch (err) {
      console.error('⚠️ Failed to get moduleId on startup');
    }
  }, 2000); // Wait 2 seconds for WebSocket to connect
});

// ======= HANDLE MQTT COMMANDS =======
mqttClient.on('message', async (topic, message) => {
  console.log('\n========================================');
  console.log(`📩 MQTT Command received on topic: ${topic}`);
  console.log(`📨 Raw message: ${message.toString()}`);
  
  try {
    const command = JSON.parse(message.toString());
    console.log(`📋 Parsed command:`, JSON.stringify(command, null, 2));
    
    if (command.action !== 'openGate' && command.action !== 'closeGate') {
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
    
    // Check if we have moduleId
    if (!currentModuleId) {
      console.log('⚠️ No moduleId yet, fetching it first...');
      
      // Store command as pending
      const commandId = Date.now().toString();
      pendingCommands.set(commandId, {
        action: command.action,
        originalCommand: command
      });
      
      // Get moduleId (will trigger command execution via WebSocket response)
      await getModuleId();
      
    } else {
      // We have moduleId, execute immediately
      console.log(`✅ Using cached moduleId: ${currentModuleId}`);
      await executePendingCommand({
        action: command.action,
        originalCommand: command
      });
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
console.log('\n📖 Operation Flow:');
console.log('   1. Call getModuleId API');
console.log('   2. Receive moduleId via WebSocket (function: "01")');
console.log('   3. Use moduleId in motor commands');
console.log('   4. WebSocket monitors for events');
console.log('========================================\n');
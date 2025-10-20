// RVM Agent v11.0 - With Built-in QR Scanner
// - Listens for QR scanner input from hardware
// - Publishes scanned session code to backend via MQTT
// - Backend validates and controls gate
// Save as: agent.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIGURATION =======
const CONFIG = {
  device: {
    id: 'RVM-3101'  // Change this for different machines
  },
  
  // Local Hardware API
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 10000
  },
  
  // MQTT Configuration
  mqtt: {
    brokerUrl: 'mqtts://mqtt.ceewen.xyz:8883',
    username: 'mqttuser',
    password: 'mqttUser@2025',
    caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: `rvm/RVM-3101/commands`,
      autoControl: `rvm/RVM-3101/control/auto`,
      cycleComplete: `rvm/RVM-3101/cycle/complete`,
      aiResult: `rvm/RVM-3101/ai/result`,
      weightResult: `rvm/RVM-3101/weight/result`,
      status: `rvm/RVM-3101/status`,
      qrScanned: `rvm/RVM-3101/qr/scanned`  // NEW: QR scanner topic
    }
  },
  
  // Motor Configuration
  motors: {
    gate: { motorId: "01" },
    belt: { motorId: "02" },
    compactor: { motorId: "04" },
    stepper: { moduleId: '09' }
  },
  
  // Detection Thresholds
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25
  },
  
  // Timing (milliseconds)
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 10000,
    positionSettle: 500,
    gateOperation: 1000
  },
  
  // Weight Calibration
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ======= STATE =======
const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  sessionId: null,
  gateOpen: false,
  waitingForQR: false  // NEW: Track if waiting for QR scan
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// ======= MATERIAL DETECTION =======
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } else if (className.includes('pet') || className.includes('plastic') || 
             className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
  }
  
  const confidencePercent = Math.round(probability * 100);
  const thresholdPercent = Math.round(threshold * 100);
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    console.log(`⚠️  ${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`);
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    console.log(`✅ ${materialType} detected (${confidencePercent}%)`);
  }
  
  return materialType;
}

// ======= HARDWARE COMMANDS =======
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  
  if (!state.moduleId && action !== 'getModuleId') {
    throw new Error('Module ID not available');
  }
  
  let apiUrl, apiPayload;
  
  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { 
        moduleId: state.moduleId, 
        motorId: '01', 
        type: '03', 
        deviceType 
      };
      state.gateOpen = true;
      break;
      
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { 
        moduleId: state.moduleId, 
        motorId: '01', 
        type: '00', 
        deviceType 
      };
      state.gateOpen = false;
      break;
      
    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
      
    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
      
    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      apiPayload = {};
      break;
      
    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      apiPayload = {
        moduleId: '09',
        id: params.position,
        type: params.position,
        deviceType
      };
      break;
      
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: state.moduleId,
        motorId: params.motorId,
        type: params.type,
        deviceType
      };
      break;
      
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  await axios.post(apiUrl, apiPayload, {
    timeout: CONFIG.local.timeout,
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (action === 'takePhoto') await delay(1500);
  if (action === 'getWeight') await delay(2000);
}

// ======= AUTO CYCLE =======
async function executeAutoCycle() {
  const cycleStartTime = Date.now();
  state.sessionId = generateSessionId();
  
  console.log('\n========================================');
  console.log('🚀 CYCLE START');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️  Weight: ${state.weight.weight}g`);
  console.log('========================================\n');
  
  try {
    // Step 1: Belt to weight position
    console.log('▶️  Moving to weight position...');
    await executeCommand('customMotor', { motorId: "02", type: "02" });
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', { motorId: "02", type: "00" });
    
    // Step 2: Belt to stepper position
    console.log('▶️  Moving to stepper position...');
    await executeCommand('customMotor', { motorId: "02", type: "03" });
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', { motorId: "02", type: "00" });
    await delay(CONFIG.timing.positionSettle);
    
    // Step 3: Stepper dump
    console.log('▶️  Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' ? '02' : '03';
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    // Step 4: Compactor
    console.log('▶️  Crushing...');
    await executeCommand('customMotor', { motorId: "04", type: "01" });
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', { motorId: "04", type: "00" });
    
    // Step 5: Belt return
    console.log('▶️  Returning belt...');
    await executeCommand('customMotor', { motorId: "02", type: "01" });
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', { motorId: "02", type: "00" });
    
    // Step 6: Stepper reset
    console.log('▶️  Resetting stepper...');
    await executeCommand('stepperMotor', { position: '01' });
    await delay(CONFIG.timing.stepperReset);
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log('========================================\n');
    
    // Publish complete transaction data to backend
    const transactionData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      rawWeight: state.weight.rawWeight,
      confidence: state.aiResult.matchRate,
      aiClassName: state.aiResult.className,
      aiTaskId: state.aiResult.taskId,
      cycleTime: cycleTime,
      timestamp: new Date().toISOString(),
      status: 'success'
    };
    
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete, 
      JSON.stringify(transactionData),
      { qos: 1, retain: false }
    );
    
    console.log('📤 Transaction published to backend');
    
    // Reset state for next item
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    state.sessionId = null;
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', error.message);
    console.error('========================================\n');
    
    // Publish failure
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete,
      JSON.stringify({
        sessionId: state.sessionId,
        deviceId: CONFIG.device.id,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { qos: 1 }
    );
    
    // Emergency stop
    console.log('🛑 Emergency stop...');
    try {
      await executeCommand('customMotor', { motorId: "02", type: "00" });
      await executeCommand('customMotor', { motorId: "04", type: "00" });
      await executeCommand('stepperMotor', { position: '01' });
      await delay(CONFIG.timing.stepperReset);
    } catch (stopError) {
      console.error('❌ Emergency stop failed:', stopError.message);
    }
    
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
  }
}

// ======= REQUEST MODULE ID =======
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

// ======= WEBSOCKET =======
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      // Module ID response
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      // ===== NEW: QR SCANNER INPUT =====
      // Hardware QR scanner sends scanned code via WebSocket
      if (message.function === 'qrcode') {
        const sessionCode = message.data;  // 8-16 digit code from QR
        console.log(`📱 QR Code scanned: ${sessionCode}`);
        
        // Publish to MQTT so backend can validate
        mqttClient.publish(
          CONFIG.mqtt.topics.qrScanned,
          JSON.stringify({
            deviceId: CONFIG.device.id,
            sessionCode: sessionCode,
            timestamp: new Date().toISOString()
          }),
          { qos: 1 }
        );
        
        console.log('📤 QR code sent to backend for validation');
        state.waitingForQR = false;
        return;
      }
      // =====================================
      
      // AI Photo result
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const probability = aiData.probability || 0;
        
        state.aiResult = {
          matchRate: Math.round(probability * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className || '',
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
        
        // Publish AI result
        mqttClient.publish(
          CONFIG.mqtt.topics.aiResult,
          JSON.stringify(state.aiResult),
          { qos: 1 }
        );
        
        // Check if should proceed
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️  Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)`);
          }
        }
        return;
      }
      
      // Weight result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: coefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️  Weight: ${state.weight.weight}g`);
        
        // Publish weight result
        mqttClient.publish(
          CONFIG.mqtt.topics.weightResult,
          JSON.stringify(state.weight),
          { qos: 1 }
        );
        
        // Calibrate if needed
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️  Calibrating weight (${state.calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        // Start cycle if ready
        if (state.autoCycleEnabled && 
            state.aiResult && 
            state.weight.weight > 1 && 
            !state.cycleInProgress &&
            state.gateOpen) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Object detection - only trigger if gate is open
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        
        // Code 4 = infrared body sensor detected object
        if (code === 4 && 
            state.autoCycleEnabled && 
            !state.cycleInProgress &&
            state.gateOpen) {
          console.log('👤 Object detected in open gate');
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ WebSocket error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️  WebSocket closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
}

// ======= MQTT =======
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  
  // Publish online status
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'online',
      gateOpen: state.gateOpen,
      autoMode: state.autoCycleEnabled,
      cycleInProgress: state.cycleInProgress,
      timestamp: new Date().toISOString()
    }),
    { retain: true, qos: 1 }
  );
  
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Auto mode control from backend
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto mode: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      // Open or close gate based on auto mode
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
        console.log('🚪 Gate opened (auto mode enabled)');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
        console.log('🚪 Gate closed (auto mode disabled)');
      }
      
      // Publish status update
      mqttClient.publish(
        CONFIG.mqtt.topics.status,
        JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'online',
          gateOpen: state.gateOpen,
          autoMode: state.autoCycleEnabled,
          cycleInProgress: state.cycleInProgress,
          timestamp: new Date().toISOString()
        }),
        { retain: true, qos: 1 }
      );
      return;
    }
    
    // Manual commands from backend
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      } else {
        console.error('❌ Cannot execute command: Module ID not available');
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

mqttClient.on('error', (error) => {
  console.error('❌ MQTT connection error:', error);
});

mqttClient.on('close', () => {
  console.log('⚠️  MQTT disconnected');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down...');
  
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'offline',
      timestamp: new Date().toISOString()
    }),
    { retain: true, qos: 1 }
  );
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v11.0 - WITH QR SCANNER');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('========================================');
console.log('📡 MQTT Topics:');
console.log(`   Commands: ${CONFIG.mqtt.topics.commands}`);
console.log(`   Auto Control: ${CONFIG.mqtt.topics.autoControl}`);
console.log(`   Cycle Complete: ${CONFIG.mqtt.topics.cycleComplete}`);
console.log(`   QR Scanned: ${CONFIG.mqtt.topics.qrScanned}`);
console.log('========================================');
console.log('🎯 Detection Thresholds:');
console.log(`   Metal: ${CONFIG.detection.METAL_CAN * 100}%`);
console.log(`   Plastic: ${CONFIG.detection.PLASTIC_BOTTLE * 100}%`);
console.log(`   Glass: ${CONFIG.detection.GLASS * 100}%`);
console.log('========================================\n');
console.log('⏳ Connecting...\n');
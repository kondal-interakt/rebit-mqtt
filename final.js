// RVM Agent v8.1 - PRODUCTION WITH QR CODE + DEBUG
// - Fixed QR code detection and automatic gate opening
// - Enhanced WebSocket message handling
// - Better error handling and debugging

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ======= CONFIGURATION =======
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  // Local Hardware API - FIXED WebSocket URL
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsz1234', // Fixed: qazwsz1234 not qazwsx1234
    timeout: 10000
  },
  
  // MQTT Configuration
  mqtt: {
    brokerUrl: 'mqtts://mqtt.ceewen.xyz:8883',
    username: 'mqttuser',
    password: 'mqttUser@2025',
    caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      qrScanned: 'rvm/RVM-3101/qr/scanned',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status'
    }
  },
  
  // Motor Configuration
  motors: {
    belt: {
      toWeight: { motorId: "02", type: "02" },
      toStepper: { motorId: "02", type: "03" },
      reverse: { motorId: "02", type: "01" },
      stop: { motorId: "02", type: "00" }
    },
    compactor: {
      start: { motorId: "04", type: "01" },
      stop: { motorId: "04", type: "00" }
    },
    stepper: {
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
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
  currentUserId: null,
  scanTimestamp: null
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
    console.log(`⚠️ ${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`);
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    console.log(`✅ ${materialType} detected (${confidencePercent}%)`);
  }
  
  return materialType;
}

// ======= DEDICATED QR CODE HANDLER =======
async function handleQRCodeData(qrData) {
  const qrCodeData = qrData.toString().trim();
  
  console.log(`\n📱 QR CODE SCANNED!`);
  console.log(`   Raw data: "${qrCodeData}"`);
  console.log(`   Length: ${qrCodeData.length}`);
  console.log(`   Module ID: ${state.moduleId || 'NOT SET'}`);
  console.log(`   Auto mode: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
  
  // Validate QR code format (8-16 digits as per document)
  if (qrCodeData && qrCodeData.length >= 8 && qrCodeData.length <= 16 && /^\d+$/.test(qrCodeData)) {
    console.log('✅ Valid QR code format detected');
    console.log(`👤 User ID: ${qrCodeData}`);
    
    // Store user info
    state.currentUserId = qrCodeData;
    state.scanTimestamp = new Date().toISOString();
    
    // Publish QR scan event to MQTT
    mqttClient.publish(
      CONFIG.mqtt.topics.qrScanned,
      JSON.stringify({
        userId: qrCodeData,
        deviceId: CONFIG.device.id,
        timestamp: state.scanTimestamp,
        moduleId: state.moduleId
      }),
      { qos: 1 }
    );
    
    console.log('📤 Published QR scan to MQTT');
    
    // Enable auto mode and open gate
    if (!state.autoCycleEnabled) {
      console.log('🤖 Auto-enabling from QR scan...');
      state.autoCycleEnabled = true;
    }
    
    // Always try to open gate when QR is scanned (if moduleId available)
    if (state.moduleId) {
      try {
        console.log('🚪 Opening gate with module ID:', state.moduleId);
        await executeCommand('openGate');
        console.log('✅ Gate opened successfully - Ready for bottle\n');
        
        // Publish status update
        mqttClient.publish(
          CONFIG.mqtt.topics.status,
          JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            autoMode: true,
            userId: state.currentUserId,
            timestamp: new Date().toISOString()
          }),
          { retain: true }
        );
        
      } catch (error) {
        console.error('❌ Failed to open gate:', error.message);
        console.log('🔧 Please check if the middle layer service is running on port 8081');
      }
    } else {
      console.log('❌ Cannot open gate: Module ID not available');
      console.log('🔄 Requesting module ID...');
      await requestModuleId();
    }
  } else {
    console.log(`⚠️ Invalid QR code format`);
    console.log(`   Expected: 8-16 digit number`);
    console.log(`   Received: "${qrCodeData}" (${qrCodeData.length} chars)`);
    console.log(`   Is numeric: ${/^\d+$/.test(qrCodeData)}\n`);
  }
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
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      break;
      
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '00', deviceType };
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
        moduleId: CONFIG.motors.stepper.moduleId,
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
  
  // Small delays for specific actions
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
  if (state.currentUserId) {
    console.log(`👤 User: ${state.currentUserId}`);
  }
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');
  
  try {
    // Step 1: Open Gate
    console.log('▶️ Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    // Step 2: Belt to weight position
    console.log('▶️ Moving to weight position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 3: Belt to stepper position
    console.log('▶️ Moving to stepper position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    // Step 4: Stepper dump
    console.log('▶️ Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    // Step 5: Compactor
    console.log('▶️ Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    // Step 6: Belt return
    console.log('▶️ Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    // Step 7: Stepper reset
    console.log('▶️ Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    // Step 8: Close gate
    console.log('▶️ Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log('========================================\n');
    
    // Publish complete transaction data to MQTT
    const transactionData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId || null,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      rawWeight: state.weight.rawWeight,
      confidence: state.aiResult.matchRate,
      aiClassName: state.aiResult.className,
      aiTaskId: state.aiResult.taskId,
      cycleTime: cycleTime,
      timestamp: new Date().toISOString(),
      scanTimestamp: state.scanTimestamp || null,
      status: 'success'
    };
    
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete, 
      JSON.stringify(transactionData),
      { qos: 1, retain: false }
    );
    
    console.log('📤 Transaction published to MQTT');
    console.log(`   Topic: ${CONFIG.mqtt.topics.cycleComplete}`);
    
    // Reset state
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    state.sessionId = null;
    state.currentUserId = null;
    state.scanTimestamp = null;
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ CYCLE FAILED:', error.message);
    console.error('========================================\n');
    
    // Publish failure to MQTT
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete,
      JSON.stringify({
        sessionId: state.sessionId,
        deviceId: CONFIG.device.id,
        userId: state.currentUserId || null,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { qos: 1 }
    );
    
    // Emergency stop
    console.log('🛑 Emergency stop...');
    try {
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(CONFIG.timing.stepperReset);
      await executeCommand('closeGate');
    } catch (stopError) {
      console.error('❌ Emergency stop failed:', stopError.message);
    }
    
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.scanTimestamp = null;
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
    console.log('✅ WebSocket connected to:', CONFIG.local.wsUrl);
    console.log('📡 Waiting for QR codes and other events...');
    setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const rawMessage = data.toString().trim();
      console.log('\n🔍 RAW WebSocket Message:', rawMessage);
      
      let message;
      try {
        message = JSON.parse(rawMessage);
      } catch (parseError) {
        console.log('⚠️ Non-JSON message, treating as QR code data');
        // Handle raw string as potential QR code
        await handleQRCodeData(rawMessage);
        return;
      }
      
      // ===== DEBUG: LOG STRUCTURED MESSAGE =====
      console.log('📦 PARSED WebSocket Message:');
      console.log('   Keys:', Object.keys(message));
      console.log('   Full message:', JSON.stringify(message, null, 2));
      
      // Module ID response - FIXED based on document
      if (message.function === "01" || message.data === "1") {
        state.moduleId = message.data || "05"; // Default to "05" if not provided
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
      // QR Code Scanner - MULTIPLE POSSIBLE FORMATS
      if (message.function === 'qrcode' || 
          message.function === 'QRCODE' || 
          message.qrcode || 
          message.qr || 
          message.data && (message.data.length >= 8 && message.data.length <= 16)) {
        
        const qrCodeData = message.data || message.qrcode || message.qr || rawMessage;
        await handleQRCodeData(qrCodeData);
        return;
      }
      
      // AI Photo result
      if (message.function === 'aiPhoto' || message.aiPhoto) {
        const aiData = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
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
          JSON.stringify(state.aiResult)
        );
        
        // Check if should proceed
        if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)`);
          }
        }
        return;
      }
      
      // Weight result
      if (message.function === '06' || message.weight) {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: coefficient,
          timestamp: new Date().toISOString()
        };
        
        console.log(`⚖️ Weight: ${state.weight.weight}g`);
        
        // Publish weight result
        mqttClient.publish(
          CONFIG.mqtt.topics.weightResult,
          JSON.stringify(state.weight)
        );
        
        // Calibrate if needed
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${state.calibrationAttempts}/2)...`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        // Start cycle if ready
        if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      // Object detection / Device status
      if (message.function === 'deviceStatus' || message.deviceStatus) {
        const code = parseInt(message.data) || -1;
        console.log(`📡 Device Status: ${code}`);
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          console.log('👤 Object detected - Taking photo...');
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
      // Unknown message format
      console.log('❓ Unknown message format, but let me check if it contains QR data...');
      if (rawMessage.length >= 8 && rawMessage.length <= 16 && /^\d+$/.test(rawMessage)) {
        console.log('🔍 This looks like a QR code! Processing...');
        await handleQRCodeData(rawMessage);
      }
      
    } catch (error) {
      console.error('❌ WebSocket message processing error:', error.message);
      console.error('   Raw data:', data.toString());
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5 seconds...');
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
      timestamp: new Date().toISOString()
    }),
    { retain: true }
  );
  
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Auto mode control
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto mode: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
      }
      return;
    }
    
    // Manual commands
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      // Manual material override
      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          state.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL_OVERRIDE',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`🔧 Manual override: ${payload.materialType}`);
          
          if (state.autoCycleEnabled) {
            setTimeout(() => executeCommand('getWeight'), 500);
          }
        }
        return;
      }
      
      // Execute command
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  
  // Publish offline status
  mqttClient.publish(
    CONFIG.mqtt.topics.status,
    JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'offline',
      timestamp: new Date().toISOString()
    }),
    { retain: true }
  );
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  process.exit(0);
});

// ======= STARTUP =======
console.log('========================================');
console.log('🚀 RVM AGENT v8.1 - PRODUCTION + DEBUG');
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
console.log('========================================');
console.log('📱 QR Code Support: ENABLED');
console.log('   Format: 8-16 character string');
console.log('   Auto-enable: YES');
console.log('   Auto-gate: YES');
console.log('========================================');
console.log('🔍 DEBUG MODE: ON');
console.log('   All WebSocket messages will be logged');
console.log('========================================\n');
console.log('⏳ Connecting...\n');
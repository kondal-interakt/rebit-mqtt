const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
    timeout: 10000
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234', // CORRECT: from documentation
    timeout: 10000
  },
  
  mqtt: {
    brokerUrl: 'mqtts://mqtt.ceewen.xyz:8883',
    username: 'mqttuser',
    password: 'mqttUser@2025',
    caFile: 'C:\\Users\\YY\\rebit-mqtt\\certs\\star.ceewen.xyz.ca-bundle',
    topics: {
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status'
    }
  },
  
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
  
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 10000,
    positionSettle: 500,
    gateOperation: 1000,
    autoPhotoDelay: 5000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

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
  currentUserData: null,
  autoPhotoTimer: null,
  wsReady: false
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// ============ WebSocket Management ============
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    console.log('🔌 Connecting WebSocket...');
    
    // Close existing WebSocket if any
    if (state.ws) {
      state.ws.removeAllListeners();
      state.ws.close();
      state.ws = null;
    }
    
    state.ws = new WebSocket(CONFIG.local.wsUrl);
    state.wsReady = false;
    
    state.ws.on('open', () => {
      console.log('✅ WebSocket connected to:', CONFIG.local.wsUrl);
      state.wsReady = true;
      resolve();
    });
    
    state.ws.on('message', (data) => {
      handleWebSocketMessage(data);
    });
    
    state.ws.on('close', (code, reason) => {
      console.log(`⚠️ WebSocket closed: ${code} - ${reason}`);
      state.wsReady = false;
      
      if (!state.cycleInProgress) {
        setTimeout(() => {
          console.log('🔄 Reconnecting WebSocket...');
          connectWebSocket();
        }, 5000);
      }
    });
    
    state.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
      state.wsReady = false;
      reject(error);
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      if (!state.wsReady) {
        console.error('❌ WebSocket connection timeout');
        reject(new Error('WebSocket connection timeout'));
      }
    }, 10000);
  });
}

// ============ WebSocket Message Handler ============
async function handleWebSocketMessage(data) {
  try {
    const message = JSON.parse(data.toString());
    console.log('📨 WebSocket Message - Function:', message.function, 'Data:', message.data);
    
    if (message.function === '01') {
      state.moduleId = message.moduleId || message.data;
      console.log(`✅ Module ID: ${state.moduleId}`);
      return;
    }
    
    // ============ NEW: QR CODE HANDLING ============
    if (message.function === 'qrcode') {
      const qrCode = message.data;
      console.log('\n========================================');
      console.log('📱 QR CODE SCANNED VIA WEBSOCKET');
      console.log('========================================');
      console.log(`🔢 QR Code: ${qrCode}`);
      console.log('========================================\n');
      
      // Validate the QR code with backend
      await handleQRCodeValidation(qrCode);
      return;
    }
    
    // ONLY process AI/Weight messages if we have an active user session
    if (!state.currentUserId) {
      console.log('⚠️ Ignoring WebSocket message - no active user session');
      return;
    }
    
    if (message.function === 'aiPhoto') {
      let aiData;
      try {
        aiData = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
      } catch (e) {
        console.error('❌ Failed to parse AI data:', e.message);
        return;
      }
      
      const probability = aiData.probability || 0;
      
      state.aiResult = {
        matchRate: Math.round(probability * 100),
        materialType: determineMaterialType(aiData),
        className: aiData.className || '',
        taskId: aiData.taskId,
        timestamp: new Date().toISOString()
      };
      
      console.log(`🤖 AI: ${state.aiResult.materialType} (${state.aiResult.matchRate}%)`);
      
      mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
      
      if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
        const threshold = CONFIG.detection[state.aiResult.materialType];
        const thresholdPercent = Math.round(threshold * 100);
        
        if (state.aiResult.matchRate >= thresholdPercent) {
          console.log('✅ Proceeding to weight...\n');
          setTimeout(() => executeCommand('getWeight'), 500);
        } else {
          console.log(`⚠️ Low confidence (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
        }
      }
      return;
    }
    
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
      
      console.log(`⚖️ Weight: ${state.weight.weight}g`);
      
      mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
      
      if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
        state.calibrationAttempts++;
        console.log(`⚠️ Calibrating (${state.calibrationAttempts}/2)...\n`);
        setTimeout(async () => {
          await executeCommand('calibrateWeight');
          setTimeout(() => executeCommand('getWeight'), 1000);
        }, 500);
        return;
      }
      
      if (state.weight.weight > 0) state.calibrationAttempts = 0;
      
      if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
        state.cycleInProgress = true;
        setTimeout(() => executeAutoCycle(), 1000);
      }
      return;
    }
    
    if (message.function === 'deviceStatus') {
      const code = parseInt(message.data) || -1;
      
      if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress && state.currentUserId) {
        console.log('👤 OBJECT DETECTED!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        setTimeout(() => executeCommand('takePhoto'), 1000);
      }
      return;
    }
    
  } catch (error) {
    console.error('❌ WebSocket message error:', error.message);
  }
}

// ============ NEW: QR Code Validation ============
async function handleQRCodeValidation(qrCode) {
  // Check if system is busy
  if (state.cycleInProgress || state.currentUserId) {
    console.log('⚠️ System busy, ignoring QR scan. Current user:', state.currentUserId);
    return;
  }
  
  console.log('🔐 Validating QR code with backend...');
  
  try {
    const response = await axios.post(
      `${CONFIG.backend.url}${CONFIG.backend.validateEndpoint}`,
      { sessionCode: qrCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    const data = response.data;
    console.log('✅ Backend validation response:', data);
    
    if (data.success) {
      console.log('\n========================================');
      console.log('✅ QR CODE VALIDATED BY BACKEND');
      console.log('========================================');
      console.log(`👤 User: ${data.user?.name || data.user?.username || 'Unknown'}`);
      console.log(`🔑 User ID: ${data.user?.id || 'Unknown'}`);
      console.log(`📱 QR Code: ${qrCode}`);
      console.log('========================================\n');
      
      // Start the recycling process
      await startRecyclingProcess(data.user, qrCode);
    } else {
      console.log('❌ QR code validation failed:', data.error);
    }
    
  } catch (error) {
    console.error('❌ QR code validation error:', error.message);
  }
}

// ============ NEW: Start Recycling Process ============
async function startRecyclingProcess(user, qrCode) {
  state.currentUserId = user?.id || 'unknown';
  state.currentUserData = {
    name: user?.name || user?.username || 'Unknown',
    sessionCode: qrCode,
    timestamp: new Date().toISOString()
  };
  
  state.autoCycleEnabled = true;
  
  console.log('🔧 Preparing system for new user...');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  await executeCommand('customMotor', CONFIG.motors.compactor.stop);
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  console.log('✅ System prepared\n');
  
  console.log('🚪 Opening gate...');
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate opened!\n');
  
  console.log('⏱️ Auto photo in 5 seconds...\n');
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    console.log('📸 AUTO PHOTO!\n');
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
}

// ============ Scanner Reset Function ============
async function resetScannerForNextUser() {
  console.log('\n🔄 RESETTING SCANNER FOR NEXT USER');
  
  // Clear all user-specific data FIRST
  state.currentUserId = null;
  state.currentUserData = null;
  state.autoCycleEnabled = false;
  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.sessionId = null;
  
  // Reset motors to home position
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await executeCommand('closeGate');
    console.log('✅ All motors reset to home position');
  } catch (error) {
    console.error('❌ Motor reset failed:', error.message);
  }
  
  // Clear any pending timers
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  console.log('🟢 READY FOR NEXT QR SCAN\n');
  
  // Publish ready status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    timestamp: new Date().toISOString()
  }));
}

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
  
  console.log(`🔧 Executing: ${action}`, apiPayload);
  
  try {
    const response = await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`✅ ${action} successful`);
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    console.error(`❌ ${action} failed:`, error.message);
    throw error;
  }
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing data');
    state.cycleInProgress = false;
    return;
  }

  const cycleStartTime = Date.now();
  state.sessionId = generateSessionId();
  
  console.log('\n========================================');
  console.log('🚀 CYCLE START');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`👤 User: ${state.currentUserId}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');

  try {
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
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

    // Step 7: Reset stepper
    console.log('▶️ Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    // Step 8: Close gate
    console.log('▶️ Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);

    const cycleEndTime = Date.now();
    const cycleData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      aiMatchRate: state.aiResult.matchRate,
      userId: state.currentUserId,
      timestamp: new Date().toISOString(),
      cycleDuration: cycleEndTime - cycleStartTime
    };

    // Publish cycle complete to backend
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
    
    console.log('========================================');
    console.log('✅ CYCLE COMPLETE');
    console.log(`⏱️ Duration: ${Math.round((cycleEndTime - cycleStartTime) / 1000)}s`);
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Cycle error:', error.message);
  } finally {
    // CRITICAL: Clear all cycle data and reset for next user
    state.cycleInProgress = false;
    
    // Reset scanner for next user after a short delay
    setTimeout(async () => {
      await resetScannerForNextUser();
    }, 2000);
  }
}

async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP');
  
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('closeGate');
    
    // Reset all states
    state.cycleInProgress = false;
    state.autoCycleEnabled = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    state.calibrationAttempts = 0;
    state.sessionId = null;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    console.log('✅ Emergency stop complete - Scanner reset');
    
    // Publish reset status
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    console.error('❌ Emergency stop failed:', error.message);
  }
}

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', async () => {
  console.log('✅ MQTT connected');
  
  // Subscribe to commands
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.autoControl);
  
  console.log('✅ Subscribed to MQTT topics');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  // Initialize WebSocket
  try {
    await connectWebSocket();
    console.log('✅ WebSocket initialized - Ready for QR scans');
  } catch (error) {
    console.error('❌ WebSocket initialization failed:', error.message);
  }
  
  setTimeout(() => {
    requestModuleId();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    console.log(`📩 MQTT Message - Topic: ${topic}`);
    
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto Cycle: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
      if (state.autoCycleEnabled && state.moduleId) {
        await executeCommand('openGate');
      } else if (!state.autoCycleEnabled && state.moduleId) {
        await executeCommand('closeGate');
      }
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
      if (payload.action === 'emergencyStop') {
        await emergencyStop();
        return;
      }
      
      if (payload.action === 'resetScanner') {
        console.log('🔄 MANUAL SCANNER RESET');
        await resetScannerForNextUser();
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await executeCommand('takePhoto');
        return;
      }
      
      if (payload.action === 'getStatus') {
        const status = getCurrentStatus();
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify(status));
        console.log('📊 Status:', status);
        return;
      }
      
      if (payload.action === 'testQR') {
        console.log('🧪 TEST: Simulating QR scan');
        // Simulate a QR code for testing
        const testQR = '123456789012';
        await handleQRCodeValidation(testQR);
        return;
      }
      
      if (payload.action === 'setMaterial') {
        const validMaterials = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (validMaterials.includes(payload.materialType)) {
          state.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL',
            taskId: 'manual_' + Date.now(),
            timestamp: new Date().toISOString()
          };
          console.log(`🔧 Manual material set: ${payload.materialType}`);
          
          if (state.autoCycleEnabled) {
            setTimeout(() => executeCommand('getWeight'), 500);
          }
        }
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

async function requestModuleId() {
  try {
    console.log('🔧 Requesting Module ID...');
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('✅ Module ID request sent');
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

function getCurrentStatus() {
  return {
    deviceId: CONFIG.device.id,
    status: state.cycleInProgress ? 'processing' : (state.currentUserId ? 'occupied' : 'ready'),
    currentUser: state.currentUserId,
    autoCycleEnabled: state.autoCycleEnabled,
    cycleInProgress: state.cycleInProgress,
    aiResult: state.aiResult ? state.aiResult.materialType : null,
    weight: state.weight ? state.weight.weight : null,
    wsConnected: state.wsReady,
    moduleId: state.moduleId,
    timestamp: new Date().toISOString()
  };
}

// ============ Periodic Status Updates ============
setInterval(() => {
  const status = getCurrentStatus();
  console.log('📊 Status Check:', status.status, 'User:', status.currentUser || 'None', 'WS:', status.wsConnected ? '✅' : '❌');
  
  // Publish status every 30 seconds
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify(status));
}, 30000);

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) {
    state.ws.removeAllListeners();
    state.ws.close();
  }
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);

console.log('========================================');
console.log('🚀 RVM AGENT - WEBSOCKET QR MODE');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔌 WebSocket: ${CONFIG.local.wsUrl}`);
console.log(`📡 MQTT Broker: ${CONFIG.mqtt.brokerUrl}`);
console.log('✅ Listening for QR codes via WebSocket');
console.log('✅ Function: qrcode (from documentation)');
console.log('========================================');
console.log('⏳ Starting...\n');
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
    cycleCompleteEndpoint: '/api/rvm/RVM-3101/cycle/complete',
    timeout: 10000
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
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
      status: 'rvm/RVM-3101/status',
      qrScan: 'rvm/RVM-3101/qr/scanned',
      finishRecycle: 'rvm/RVM-3101/recycle/finish',
      bottleCount: 'rvm/RVM-3101/bottle/count'
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
    compactor: 24000,
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
  // Multi-bottle session tracking
  sessionActive: false,
  bottleCount: 0,
  sessionBottles: [],
  sessionStartTime: null,
  // NEW: Loop protection flags
  isPreparingNextBottle: false,
  isResettingSystem: false,
  motorStopAttempts: 0,
  maxMotorStopAttempts: 3
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

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
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    console.error(`❌ ${action} failed:`, error.message);
    throw error;
  }
}

// ============ NEW: Safe motor stop with retry limit ============
async function safeStopMotors() {
  console.log('🛑 Stopping all motors...');
  
  let beltStopped = false;
  let compactorStopped = false;
  let attempts = 0;
  const maxAttempts = 3;
  
  while ((!beltStopped || !compactorStopped) && attempts < maxAttempts) {
    attempts++;
    console.log(`   Attempt ${attempts}/${maxAttempts}`);
    
    try {
      if (!beltStopped) {
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        beltStopped = true;
        console.log('   ✅ Belt stopped');
      }
    } catch (error) {
      console.error(`   ⚠️ Belt stop failed: ${error.message}`);
    }
    
    try {
      if (!compactorStopped) {
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        compactorStopped = true;
        console.log('   ✅ Compactor stopped');
      }
    } catch (error) {
      console.error(`   ⚠️ Compactor stop failed: ${error.message}`);
    }
    
    if (!beltStopped || !compactorStopped) {
      console.log(`   ⏳ Retrying in 1 second...`);
      await delay(1000);
    }
  }
  
  if (!beltStopped || !compactorStopped) {
    console.error('❌ WARNING: Some motors may still be running!');
    return false;
  }
  
  console.log('✅ All motors stopped\n');
  return true;
}

// ============ FIXED: Prepare for next bottle with loop protection ============
async function prepareForNextBottle() {
  // CRITICAL: Prevent multiple simultaneous calls
  if (state.isPreparingNextBottle) {
    console.log('⚠️ Already preparing for next bottle, skipping...');
    return;
  }
  
  state.isPreparingNextBottle = true;
  
  console.log('\n========================================');
  console.log('🔄 PREPARING FOR NEXT BOTTLE');
  console.log(`📦 Current count: ${state.bottleCount} bottles`);
  console.log('========================================\n');
  
  try {
    // Safe motor stop with retry limit
    const motorsStopped = await safeStopMotors();
    
    if (!motorsStopped) {
      console.error('❌ Failed to stop motors after max attempts!');
      console.log('🚨 Triggering emergency stop...');
      await emergencyStop();
      state.isPreparingNextBottle = false;
      return;
    }
    
    // Reset stepper to home position
    console.log('🏠 Resetting stepper to home...');
    try {
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(CONFIG.timing.stepperReset);
      console.log('✅ Stepper reset\n');
    } catch (error) {
      console.error('❌ Stepper reset failed:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Prepare error:', error.message);
  } finally {
    // ALWAYS clear the flag
    state.isPreparingNextBottle = false;
  }
  
  // Clear only cycle-specific state (NOT session state)
  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  state.motorStopAttempts = 0;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  // Publish updated bottle count
  const bottleCountData = {
    deviceId: CONFIG.device.id,
    userId: state.currentUserId,
    sessionId: state.sessionId,
    bottleCount: state.bottleCount,
    timestamp: new Date().toISOString()
  };
  
  console.log('📤 Publishing bottle count:');
  console.log(`   MQTT Topic: ${CONFIG.mqtt.topics.bottleCount}`);
  console.log(`   Count: ${state.bottleCount}`);
  
  // Send via MQTT
  mqttClient.publish(CONFIG.mqtt.topics.bottleCount, JSON.stringify(bottleCountData), (err) => {
    if (err) {
      console.error('❌ Failed to publish bottle count to MQTT:', err);
    } else {
      console.log('✅ Bottle count published to MQTT');
    }
  });
  
  // Send via WebSocket to HTML
  if (state.ws && state.ws.readyState === 1) {
    const wsMessage = {
      function: 'bottleCount',
      data: state.bottleCount
    };
    state.ws.send(JSON.stringify(wsMessage));
    console.log('✅ Bottle count sent via WebSocket to HTML\n');
  }
  
  console.log('========================================');
  console.log('✅ READY FOR NEXT BOTTLE');
  console.log('Gate remains OPEN - Place next bottle');
  console.log('========================================\n');
  
  // Re-enable auto photo for next bottle
  console.log('⏱️  Auto photo in 5 seconds...\n');
  state.autoPhotoTimer = setTimeout(() => {
    console.log('📸 AUTO PHOTO FOR NEXT BOTTLE!\n');
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
}

// ============ Complete session and send to backend ============
async function completeRecycleSession() {
  console.log('\n========================================');
  console.log('🏁 COMPLETING RECYCLE SESSION');
  console.log('========================================');
  console.log(`📦 Total bottles recycled: ${state.bottleCount}`);
  console.log(`👤 User: ${state.currentUserData?.name || state.currentUserId}`);
  console.log(`🔑 Session: ${state.sessionId}`);
  console.log('========================================\n');
  
  // Prepare data for backend
  const sessionData = {
    deviceId: CONFIG.device.id,
    userId: state.currentUserId,
    userName: state.currentUserData?.name,
    sessionId: state.sessionId,
    sessionCode: state.currentUserData?.sessionCode,
    bottleCount: state.bottleCount,
    bottles: state.sessionBottles,
    startTime: state.sessionStartTime,
    endTime: new Date().toISOString(),
    duration: state.sessionStartTime ? 
      Math.round((Date.now() - new Date(state.sessionStartTime).getTime()) / 1000) : 0
  };
  
  try {
    // Send to backend
    console.log('📤 Sending session data to backend...');
    const response = await axios.post(
      `${CONFIG.backend.url}${CONFIG.backend.cycleCompleteEndpoint}`,
      sessionData,
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log('✅ Backend response:', response.data);
    
    // Publish to MQTT
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(sessionData));
    
  } catch (error) {
    console.error('❌ Failed to send to backend:', error.message);
    // Still publish to MQTT even if backend fails
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify({
      ...sessionData,
      error: error.message
    }));
  }
  
  // Now reset the entire system
  await resetSystemForNextScan();
}

// ============ FIXED: Reset system with loop protection ============
async function resetSystemForNextScan() {
  // CRITICAL: Prevent multiple simultaneous calls
  if (state.isResettingSystem) {
    console.log('⚠️ Already resetting system, skipping...');
    return;
  }
  
  state.isResettingSystem = true;
  
  console.log('\n========================================');
  console.log('🔄 RESETTING SYSTEM FOR NEXT SCAN');
  console.log('========================================\n');
  
  try {
    // Close the gate
    console.log('🚪 Closing gate...');
    try {
      await executeCommand('closeGate');
      await delay(CONFIG.timing.gateOperation);
      console.log('✅ Gate closed\n');
    } catch (error) {
      console.error('❌ Gate close failed:', error.message);
    }
    
    // Safe motor stop
    await safeStopMotors();
    
    // Reset stepper to home position
    console.log('🏠 Resetting stepper to home...');
    try {
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(CONFIG.timing.stepperReset);
      console.log('✅ Stepper reset\n');
    } catch (error) {
      console.error('❌ Stepper reset failed:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Reset error:', error.message);
  } finally {
    // ALWAYS clear the flag
    state.isResettingSystem = false;
  }
  
  // Clear ALL state variables
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.calibrationAttempts = 0;
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  state.sessionActive = false;
  state.bottleCount = 0;
  state.sessionBottles = [];
  state.sessionStartTime = null;
  state.motorStopAttempts = 0;
  state.isPreparingNextBottle = false;
  state.isResettingSystem = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  console.log('========================================');
  console.log('✅ SYSTEM READY FOR NEXT QR SCAN');
  console.log('========================================\n');
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing data');
    state.cycleInProgress = false;
    return;
  }

  console.log('\n========================================');
  console.log(`🤖 AUTO CYCLE #${state.bottleCount + 1}`);
  console.log('========================================');
  console.log(`📦 Material: ${state.aiResult.materialType}`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');

  try {
    console.log('▶️ Starting belt (to weight)...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    
    console.log('▶️ Belt to stepper position...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    
    console.log('🛑 Stopping belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(500);

    let stepperPosition;
    if (state.aiResult.materialType === 'METAL_CAN') {
      stepperPosition = CONFIG.motors.stepper.positions.metalCan;
      console.log('🔄 Stepper → Metal Can position');
    } else if (state.aiResult.materialType === 'PLASTIC_BOTTLE') {
      stepperPosition = CONFIG.motors.stepper.positions.plasticBottle;
      console.log('🔄 Stepper → Plastic Bottle position');
    } else {
      stepperPosition = CONFIG.motors.stepper.positions.plasticBottle;
      console.log('🔄 Stepper → Default (Plastic) position');
    }

    await executeCommand('stepperMotor', { position: stepperPosition });
    await delay(CONFIG.timing.stepperRotate);
    console.log('✅ Stepper in position\n');

    console.log('🔄 Reversing belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    
    console.log('🛑 Stopping belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(500);

    console.log('🗜️ Starting compactor...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    
    console.log('🛑 Stopping compactor...');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await delay(500);

    console.log('🏠 Resetting stepper to home...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    console.log('\n========================================');
    console.log('✅ CYCLE COMPLETE!');
    console.log('========================================\n');

    // Increment bottle count and add to session
    state.bottleCount++;
    state.sessionBottles.push({
      bottleNumber: state.bottleCount,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      timestamp: new Date().toISOString(),
      aiConfidence: state.aiResult.matchRate
    });

    console.log(`📦 Bottle #${state.bottleCount} recycled successfully!`);

    // Prepare for next bottle (keep session active)
    await prepareForNextBottle();

  } catch (error) {
    console.error('❌ Cycle error:', error.message);
    state.cycleInProgress = false;
    
    // Try to recover from error
    console.log('🔄 Attempting error recovery...');
    await safeStopMotors();
  }
}

async function emergencyStop() {
  console.log('\n🚨 EMERGENCY STOP');
  try {
    await safeStopMotors();
    await executeCommand('closeGate');
    state.autoCycleEnabled = false;
    state.cycleInProgress = false;
    state.isPreparingNextBottle = false;
    state.isResettingSystem = false;
    console.log('✅ All systems stopped');
  } catch (error) {
    console.error('❌ Emergency stop failed:', error.message);
  }
}

function connectWebSocket() {
  if (state.ws) {
    state.ws.removeAllListeners();
    state.ws.close();
  }

  state.ws = new WebSocket(CONFIG.local.wsUrl);

  state.ws.on('open', () => {
    console.log('✅ WebSocket connected\n');
  });

  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === 'qrcode') {
        console.log('📱 QR from local scanner:', message.data);
        return;
      }
      
      // Handle finish recycle from HTML
      if (message.function === 'finishRecycle') {
        console.log('\n🏁 FINISH RECYCLE received from HTML via WebSocket!');
        console.log('Data:', message.data);
        
        if (!state.sessionActive || state.bottleCount === 0) {
          console.log('⚠️ No active session to finish');
          return;
        }
        
        await completeRecycleSession();
        return;
      }
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`🔧 Module ID: ${state.moduleId}\n`);
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className || 'UNKNOWN',
          taskId: aiData.taskId || Date.now().toString(),
          timestamp: new Date().toISOString()
        };
        
        console.log(`\n🤖 AI: ${materialType} (${state.aiResult.matchRate}%)\n`);
        
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        
        if (materialType === 'UNKNOWN') {
          console.log('⚠️ Unrecognized - retaking photo in 3s\n');
          state.autoPhotoTimer = setTimeout(() => {
            executeCommand('takePhoto');
          }, 3000);
          return;
        }
        
        if (state.autoCycleEnabled) {
          setTimeout(() => executeCommand('getWeight'), 500);
        }
        return;
      }
      
      if (message.function === '02' && message.data) {
        const match = message.data.match(/(\d+)/);
        const rawWeight = match ? parseInt(match[1]) : 0;
        const coeff = CONFIG.weight.coefficients[1] || 988;
        const weight = Math.round((rawWeight / coeff) * 100) / 100;
        
        state.weight = { weight, raw: rawWeight, coefficient: coeff };
        console.log(`⚖️ Weight: ${weight}g\n`);
        
        if (weight === 0) {
          state.calibrationAttempts++;
          if (state.calibrationAttempts >= 5) {
            console.log('❌ Calibration failed 5 times\n');
            state.cycleInProgress = false;
            state.calibrationAttempts = 0;
            return;
          }
          
          console.log(`🔄 Weight = 0, recalibrating... (${state.calibrationAttempts}/5)\n`);
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
        
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
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
      console.error('❌ WS error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WS closed, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    console.error('❌ WS error:', error.message);
  });
}

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
  mqttClient.subscribe(CONFIG.mqtt.topics.qrScan);
  mqttClient.subscribe(CONFIG.mqtt.topics.finishRecycle);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  setTimeout(() => {
    requestModuleId();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // Handle finish recycle command
    if (topic === CONFIG.mqtt.topics.finishRecycle) {
      if (!state.sessionActive || state.bottleCount === 0) {
        console.log('⚠️ No active session to finish');
        return;
      }
      
      console.log('\n🏁 FINISH RECYCLE button pressed');
      await completeRecycleSession();
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.qrScan) {
      // Check if a session is already active
      if (state.sessionActive) {
        console.log('⚠️ Session already active, ignoring QR scan');
        return;
      }
      
      // Check if a cycle is in progress
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle in progress, ignoring QR scan');
        return;
      }
      
      console.log('\n========================================');
      console.log('✅ QR VALIDATED BY BACKEND');
      console.log('========================================');
      console.log(`👤 User: ${payload.userName || payload.userId}`);
      console.log(`🔑 Session: ${payload.sessionCode}`);
      console.log('========================================\n');
      
      state.currentUserId = payload.userId;
      state.currentUserData = {
        name: payload.userName,
        sessionCode: payload.sessionCode,
        timestamp: payload.timestamp
      };
      state.sessionId = generateSessionId();
      state.sessionActive = true;
      state.bottleCount = 0;
      state.sessionBottles = [];
      state.sessionStartTime = new Date().toISOString();
      
      state.autoCycleEnabled = true;
      
      console.log('🔧 Resetting system...');
      await safeStopMotors();
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(2000);
      console.log('✅ Reset complete\n');
      
      console.log('🚪 Opening gate...');
      await executeCommand('openGate');
      await delay(CONFIG.timing.gateOperation);
      console.log('✅ Gate opened!\n');
      
      console.log('⏱️  Auto photo in 5 seconds...\n');
      
      if (state.autoPhotoTimer) {
        clearTimeout(state.autoPhotoTimer);
      }
      
      state.autoPhotoTimer = setTimeout(() => {
        console.log('📸 AUTO PHOTO!\n');
        executeCommand('takePhoto');
      }, CONFIG.timing.autoPhotoDelay);
      
      // Publish initial bottle count (0)
      console.log('📤 Publishing initial bottle count (0)');
      
      const initialCountData = {
        deviceId: CONFIG.device.id,
        userId: state.currentUserId,
        sessionId: state.sessionId,
        bottleCount: 0,
        timestamp: new Date().toISOString()
      };
      
      mqttClient.publish(CONFIG.mqtt.topics.bottleCount, JSON.stringify(initialCountData), (err) => {
        if (err) {
          console.error('❌ Failed to publish initial bottle count to MQTT:', err);
        } else {
          console.log('✅ Initial bottle count (0) published to MQTT');
        }
      });
      
      // Send via WebSocket to HTML
      if (state.ws && state.ws.readyState === 1) {
        const wsMessage = {
          function: 'bottleCount',
          data: 0
        };
        state.ws.send(JSON.stringify(wsMessage));
        console.log('✅ Initial bottle count (0) sent via WebSocket to HTML\n');
      }
      
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      console.log(`🤖 Auto: ${state.autoCycleEnabled ? 'ON' : 'OFF'}`);
      
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
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO!\n');
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await executeCommand('takePhoto');
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
          console.log(`🔧 Manual: ${payload.materialType}`);
          
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
    console.error('❌ MQTT error:', error.message);
  }
});

async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID failed:', error.message);
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);

// Keyboard input for manual finish
const readline = require('readline');
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

console.log('\n💡 TIP: Press "F" key anytime to manually FINISH current session\n');

process.stdin.on('keypress', async (str, key) => {
  if (key && key.name === 'f') {
    console.log('\n⌨️  KEYBOARD FINISH triggered!');
    if (state.sessionActive && state.bottleCount > 0) {
      await completeRecycleSession();
    } else if (!state.sessionActive) {
      console.log('⚠️  No active session to finish');
    } else if (state.bottleCount === 0) {
      console.log('⚠️  No bottles recycled yet (count: 0)');
    }
  }
  
  if (key && key.ctrl && key.name === 'c') {
    gracefulShutdown();
  }
});

console.log('========================================');
console.log('🚀 RVM AGENT - LOOP PROTECTION');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ One QR scan → Multiple bottles');
console.log('✅ Finish button to complete session');
console.log('✅ FIXED: Infinite loop protection');
console.log('✅ FIXED: Smart motor stop with retries');
console.log('✅ FIXED: Race condition prevention');
console.log('========================================');
console.log('⏳ Starting...\n');
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
  // NEW: Multi-bottle session tracking
  sessionActive: false,
  bottleCount: 0,
  sessionBottles: [],
  sessionStartTime: null
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

// ============ NEW FUNCTION: Prepare for next bottle (NOT full reset) ============
async function prepareForNextBottle() {
  console.log('\n========================================');
  console.log('🔄 PREPARING FOR NEXT BOTTLE');
  console.log(`📦 Current count: ${state.bottleCount} bottles`);
  console.log('========================================\n');
  
  try {
    // Stop motors
    console.log('🛑 Stopping motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Motors stopped\n');
    
    // Reset stepper to home position
    console.log('🏠 Resetting stepper to home...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Stepper reset\n');
    
  } catch (error) {
    console.error('❌ Prepare error:', error.message);
  }
  
  // Clear only cycle-specific state (NOT session state)
  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  // Publish updated bottle count
  mqttClient.publish(CONFIG.mqtt.topics.bottleCount, JSON.stringify({
    deviceId: CONFIG.device.id,
    userId: state.currentUserId,
    sessionId: state.sessionId,
    bottleCount: state.bottleCount,
    timestamp: new Date().toISOString()
  }));
  
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

// ============ NEW FUNCTION: Complete session and send to backend ============
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

// ============ FUNCTION: Reset system for next scan ============
async function resetSystemForNextScan() {
  console.log('\n========================================');
  console.log('🔄 RESETTING SYSTEM FOR NEXT SCAN');
  console.log('========================================\n');
  
  try {
    // Close the gate
    console.log('🚪 Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('✅ Gate closed\n');
    
    // Stop all motors
    console.log('🛑 Stopping all motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    console.log('✅ Motors stopped\n');
    
    // Reset stepper to home position
    console.log('🏠 Resetting stepper to home...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Stepper reset\n');
    
  } catch (error) {
    console.error('❌ Reset error:', error.message);
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
  }
}

async function emergencyStop() {
  console.log('\n🚨 EMERGENCY STOP');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('closeGate');
    state.autoCycleEnabled = false;
    state.cycleInProgress = false;
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
      
      if (message.function === '11') {
        state.moduleId = message.data;
        console.log(`✅ Module ID: ${state.moduleId}\n`);
        return;
      }
      
      if (message.function === '10') {
        const aiData = message.data;
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className || 'Unknown',
          taskId: aiData.taskId || Date.now().toString(),
          timestamp: new Date().toISOString()
        };
        
        console.log(`🤖 AI: ${state.aiResult.className} (${state.aiResult.matchRate}%)`);
        
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
  mqttClient.subscribe(CONFIG.mqtt.topics.finishRecycle); // NEW
  
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
    
    // ============ NEW: Handle finish recycle command ============
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
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
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
      mqttClient.publish(CONFIG.mqtt.topics.bottleCount, JSON.stringify({
        deviceId: CONFIG.device.id,
        userId: state.currentUserId,
        sessionId: state.sessionId,
        bottleCount: 0,
        timestamp: new Date().toISOString()
      }));
      
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

console.log('========================================');
console.log('🚀 RVM AGENT - MULTI-BOTTLE SESSION');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('✅ One QR scan → Multiple bottles');
console.log('✅ Finish button to complete session');
console.log('========================================');
console.log('⏳ Starting...\n');
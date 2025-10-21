// RVM Agent v8.1 - Your Working Code + Backend Validation ONLY
// Minimal change: Just adds backend validation before opening gate
// Everything else stays exactly the same!
// Save as: agent-v8.1-validated.js

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');

// ======= CONFIGURATION =======
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  // NEW: Backend validation URL
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    validateEndpoint: '/api/rvm/RVM-3101/qr/validate',
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
      qrScanned: 'rvm/RVM-3101/qr/scanned'
    }
  },
  
  qr: {
    minLength: 8,
    maxLength: 20,
    sessionTimeout: 30000
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
    gateOperation: 1000
  },
  
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
  qrScanTimestamp: null,
  sessionActive: false,
  sessionTimer: null
};

// ======= UTILITY =======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

// ======= QR SCANNER SETUP =======
function setupQRScanner() {
  console.log('\n========================================');
  console.log('📱 QR SCANNER READY');
  console.log('========================================');
  console.log(`⌨️  Listening for QR codes (${CONFIG.qr.minLength}-${CONFIG.qr.maxLength} chars)`);
  console.log('🎯 Scan QR code to start automated cycle');
  console.log('========================================\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (input) => {
    const qrCode = input.trim();
    
    if (qrCode.length >= CONFIG.qr.minLength && 
        qrCode.length <= CONFIG.qr.maxLength) {
      
      console.log(`\n📱 QR CODE SCANNED: "${qrCode}"\n`);
      await handleQRScan(qrCode);
      
    } else {
      console.log(`❌ Invalid QR: "${qrCode}" (length: ${qrCode.length})`);
    }
  });
}

// ======= NEW: BACKEND VALIDATION =======
async function validateQRWithBackend(sessionCode) {
  const url = `${CONFIG.backend.url}${CONFIG.backend.validateEndpoint}`;
  
  console.log('🔐 Validating with backend...');
  console.log(`   URL: ${url}`);
  console.log(`   Code: ${sessionCode}`);
  
  try {
    const response = await axios.post(
      url,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log(`   Status: ${response.status}`);
    
    if (response.data && response.data.success) {
      console.log('   ✅ VALID!\n');
      return { valid: true, user: response.data.user || {} };
    } else {
      console.log(`   ❌ INVALID: ${response.data?.error || 'Unknown'}\n`);
      return { valid: false, error: response.data?.error || 'Invalid QR' };
    }
    
  } catch (error) {
    console.error('   ❌ ERROR');
    
    if (error.response) {
      console.error(`   HTTP ${error.response.status}: ${error.response.data?.error || error.response.statusText}\n`);
      return { valid: false, error: error.response.data?.error || 'Validation failed' };
    }
    
    console.error(`   ${error.message}\n`);
    return { valid: false, error: error.message };
  }
}

// ======= QR SCAN HANDLER (WITH VALIDATION) =======
async function handleQRScan(qrCode) {
  const timestamp = new Date().toISOString();
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🎯 STARTING AUTOMATED CYCLE          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`👤 User ID: ${qrCode}`);
  console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
  console.log(`🔧 Module ID: ${state.moduleId || 'CHECKING...'}`);
  console.log('════════════════════════════════════════\n');
  
  // ===== NEW: VALIDATE WITH BACKEND FIRST =====
  const validation = await validateQRWithBackend(qrCode);
  
  if (!validation.valid) {
    console.log('╔════════════════════════════════════════╗');
    console.log('║       ❌ INVALID QR CODE! ❌          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`Reason: ${validation.error}`);
    console.log('Gate will NOT open');
    console.log('════════════════════════════════════════\n');
    return; // STOP HERE if invalid
  }
  // ============================================
  
  // Verify Module ID
  if (!state.moduleId) {
    console.log('⚠️ Module ID not available, requesting...\n');
    
    for (let i = 0; i < 5; i++) {
      await requestModuleId();
      await delay(1000);
      
      if (state.moduleId) {
        console.log(`✅ Module ID: ${state.moduleId}\n`);
        break;
      }
    }
    
    if (!state.moduleId) {
      console.error('❌ Cannot start - Module ID unavailable');
      console.error('   Check hardware connection\n');
      return;
    }
  }
  
  // Store session info
  state.currentUserId = qrCode;
  state.qrScanTimestamp = timestamp;
  state.sessionId = generateSessionId();
  state.sessionActive = true;
  
  console.log(`✅ Session ID: ${state.sessionId}\n`);
  
  // Publish QR scan to MQTT
  mqttClient.publish(
    CONFIG.mqtt.topics.qrScanned,
    JSON.stringify({
      userId: qrCode,
      deviceId: CONFIG.device.id,
      sessionId: state.sessionId,
      timestamp: timestamp
    }),
    { qos: 1 }
  );
  
  console.log('📤 QR scan published to MQTT\n');
  
  // START AUTOMATION SEQUENCE
  try {
    console.log('🚀 Starting automation sequence...\n');
    
    // Step 1: Enable auto mode
    console.log('▶️  [1/4] Enabling auto mode...');
    state.autoCycleEnabled = true;
    mqttClient.publish(
      CONFIG.mqtt.topics.autoControl,
      JSON.stringify({ enabled: true })
    );
    await delay(500);
    console.log('    ✅ Auto mode enabled\n');
    
    // Step 2: Reset motors
    console.log('▶️  [2/4] Resetting motors...');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(200);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await delay(200);
    await executeCommand('stepperMotor', { 
      position: CONFIG.motors.stepper.positions.home 
    });
    await delay(2000);
    console.log('    ✅ Motors reset\n');
    
    // Step 3: Open gate
    console.log('▶️  [3/4] Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    console.log('    ✅ Gate opened\n');
    
    // Step 4: Start session timeout
    console.log('▶️  [4/4] Waiting for object...');
    startSessionTimeout();
    console.log('    ✅ Ready for item\n');
    
    console.log('╔════════════════════════════════════════╗');
    console.log('║      🎉 INSERT BOTTLE/CAN NOW! 🎉     ║');
    console.log('╚════════════════════════════════════════╝\n');
    
  } catch (error) {
    console.error('╔════════════════════════════════════════╗');
    console.error('║       ❌ AUTOMATION FAILED!            ║');
    console.error('╚════════════════════════════════════════╝');
    console.error('Error:', error.message);
    console.error('════════════════════════════════════════\n');
    
    await endSession();
  }
}

// ======= SESSION TIMEOUT =======
function startSessionTimeout() {
  console.log(`⏳ Session timeout: ${CONFIG.qr.sessionTimeout / 1000} seconds\n`);
  
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
  }
  
  state.sessionTimer = setTimeout(async () => {
    if (state.sessionActive && !state.cycleInProgress) {
      console.log('\n⏰ SESSION TIMEOUT - No object detected');
      console.log('🚪 Closing gate and ending session...\n');
      await endSession();
    }
  }, CONFIG.qr.sessionTimeout);
}

// ======= END SESSION =======
async function endSession() {
  console.log('🔚 Ending session...\n');
  
  state.sessionActive = false;
  state.autoCycleEnabled = false;
  
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
  }
  
  try {
    if (state.moduleId) {
      await executeCommand('closeGate');
      console.log('✅ Gate closed\n');
    }
  } catch (error) {
    console.error('❌ Error closing gate:', error.message);
  }
  
  state.currentUserId = null;
  state.qrScanTimestamp = null;
  state.sessionId = null;
  
  console.log('✅ Session ended - Ready for next QR scan\n');
}

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
  
  if (action === 'takePhoto') await delay(1500);
  if (action === 'getWeight') await delay(2000);
}

// ======= AUTO CYCLE =======
async function executeAutoCycle() {
  const cycleStartTime = Date.now();
  
  if (state.sessionTimer) {
    clearTimeout(state.sessionTimer);
    state.sessionTimer = null;
  }
  
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         🚀 PROCESSING ITEM 🚀         ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`📋 Session: ${state.sessionId}`);
  console.log(`👤 User: ${state.currentUserId || 'N/A'}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 Confidence: ${state.aiResult.matchRate}%`);
  console.log(`⚖️  Weight: ${state.weight.weight}g`);
  console.log('════════════════════════════════════════\n');
  
  try {
    console.log('▶️  [1/8] Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    console.log('▶️  [2/8] Moving to weight...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️  [3/8] Moving to stepper...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);
    
    console.log('▶️  [4/8] Dumping to crusher...');
    const position = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan 
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);
    
    console.log('▶️  [5/8] Crushing...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    console.log('▶️  [6/8] Returning belt...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    console.log('▶️  [7/8] Resetting stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    
    console.log('▶️  [8/8] Finalizing...');
    
    const cycleTime = Math.round((Date.now() - cycleStartTime) / 1000);
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║        ✅ ITEM PROCESSED! ✅          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`⏱️  Duration: ${cycleTime} seconds`);
    console.log('════════════════════════════════════════\n');
    
    const transactionData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      userId: state.currentUserId,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      rawWeight: state.weight.rawWeight,
      confidence: state.aiResult.matchRate,
      aiClassName: state.aiResult.className,
      aiTaskId: state.aiResult.taskId,
      cycleTime: cycleTime,
      qrScanTimestamp: state.qrScanTimestamp,
      timestamp: new Date().toISOString(),
      status: 'success'
    };
    
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete, 
      JSON.stringify(transactionData),
      { qos: 1, retain: false }
    );
    
    console.log('📤 Transaction published to MQTT\n');
    
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    
    await endSession();
    
  } catch (error) {
    console.error('\n╔════════════════════════════════════════╗');
    console.error('║         ❌ CYCLE FAILED! ❌           ║');
    console.error('╚════════════════════════════════════════╝');
    console.error('Error:', error.message);
    console.error('════════════════════════════════════════\n');
    
    mqttClient.publish(
      CONFIG.mqtt.topics.cycleComplete,
      JSON.stringify({
        sessionId: state.sessionId,
        deviceId: CONFIG.device.id,
        userId: state.currentUserId,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      }),
      { qos: 1 }
    );
    
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
    
    await endSession();
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
      
      if (message.function === '01') {
        state.moduleId = message.moduleId || message.data;
        console.log(`✅ Module ID: ${state.moduleId}`);
        return;
      }
      
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
        
        mqttClient.publish(
          CONFIG.mqtt.topics.aiResult,
          JSON.stringify(state.aiResult)
        );
        
        if (state.autoCycleEnabled && state.sessionActive && 
            state.aiResult.materialType !== 'UNKNOWN') {
          const threshold = CONFIG.detection[state.aiResult.materialType];
          const thresholdPercent = Math.round(threshold * 100);
          
          if (state.aiResult.matchRate >= thresholdPercent) {
            console.log('✅ Proceeding to weight...\n');
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            console.log(`⚠️ Confidence too low (${state.aiResult.matchRate}% < ${thresholdPercent}%)\n`);
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
        
        console.log(`⚖️  Weight: ${state.weight.weight}g`);
        
        mqttClient.publish(
          CONFIG.mqtt.topics.weightResult,
          JSON.stringify(state.weight)
        );
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating weight (${state.calibrationAttempts}/2)...\n`);
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.sessionActive && state.aiResult && 
            state.weight.weight > 1 && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        if (code === 4 && state.autoCycleEnabled && state.sessionActive && 
            !state.cycleInProgress) {
          console.log('👁️  OBJECT DETECTED!');
          console.log('📸 Taking photo...\n');
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('❌ WebSocket error:', error.message);
    }
  });
  
  state.ws.on('close', () => {
    console.log('⚠️ WebSocket closed, reconnecting...');
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
  
  setTimeout(() => {
    requestModuleId();
    setupQRScanner();
  }, 2000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      console.log(`📩 Command: ${payload.action}`);
      
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
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    console.error('❌ MQTT message error:', error.message);
  }
});

process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down...');
  
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
console.log('╔════════════════════════════════════════╗');
console.log('║   RVM AGENT v8.1 + QR VALIDATION      ║');
console.log('╚════════════════════════════════════════╝');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log(`🔐 Backend: ${CONFIG.backend.url}`);
console.log('════════════════════════════════════════');
console.log('🎯 WORKFLOW:');
console.log('   1. Scan QR code');
console.log('   2. Validate with backend ⭐ NEW!');
console.log('   3. If valid → Gate opens');
console.log('   4. Insert bottle/can');
console.log('   5. AI detects + weighs');
console.log('   6. Auto-processing + crushing');
console.log('   7. Session ends');
console.log('════════════════════════════════════════');
console.log('⏳ Starting system...\n');
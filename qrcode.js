// agent-qr-stdin-simple.js - SIMPLE STDIN QR SCANNER
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline'); // Added for clean input handling

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
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
      screenState: 'rvm/RVM-3101/screen/state'
    }
  },
  
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    debug: true
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
    GLASS: 0.25,
    retryDelay: 2000,
    maxRetries: 3,
    hasObjectSensor: false,
    minValidWeight: 5
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
    autoPhotoDelay: 5000,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  isReady: false,
  
  // QR Scanner state - SIMPLIFIED
  processingQR: false,
  qrScannerActive: false,
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  itemsProcessed: 0,
  
  // Hardware state
  compactorRunning: false,
  compactorTimer: null,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': 'ℹ️',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️',
    'debug': '🔍'
  }[level] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) {
    log(message, 'debug');
  }
}

function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  
  if (className.includes('易拉罐') || className.includes('metal') || className.includes('can')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } 
  else if (className.includes('pet') || className.includes('plastic') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
  }
  
  return probability >= threshold ? materialType : 'UNKNOWN';
}

// ============================================
// SIMPLE STDIN QR SCANNER
// ============================================

/**
 * Validate QR code with backend
 */
async function validateQRWithBackend(sessionCode) {
  try {
    log(`Validating QR code: ${sessionCode}`, 'info');
    
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data.success) {
      log(`QR validated - User: ${response.data.user.name}`, 'success');
      return {
        valid: true,
        user: response.data.user,
        session: response.data.session
      };
    } else {
      log(`QR validation failed: ${response.data.error}`, 'error');
      return {
        valid: false,
        error: response.data.error || 'Invalid QR code'
      };
    }
    
  } catch (error) {
    log(`QR validation error: ${error.message}`, 'error');
    return {
      valid: false,
      error: error.response?.data?.error || error.message || 'Network error'
    };
  }
}

/**
 * Process QR code after scan complete
 */
async function processQRCode(qrData) {
  if (state.processingQR) {
    log('Already processing a QR code', 'warning');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR code length: ${cleanCode.length} chars (expected: ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength})`, 'error');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_invalid',
      message: `Invalid QR code format`,
      timestamp: new Date().toISOString()
    }));
    
    return;
  }
  
  state.processingQR = true;
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR CODE SCANNED');
  console.log('='.repeat(50));
  console.log(`QR Code: ${cleanCode}`);
  console.log('='.repeat(50) + '\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'qr_validating',
    message: 'Validating QR code...',
    timestamp: new Date().toISOString()
  }));
  
  const validation = await validateQRWithBackend(cleanCode);
  
  if (validation.valid) {
    log('QR CODE VALID - STARTING MEMBER SESSION', 'success');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validated',
      message: `Welcome ${validation.user.name}!`,
      user: validation.user,
      timestamp: new Date().toISOString()
    }));
    
    await delay(2000);
    await startMemberSession(validation);
    
  } else {
    log('QR CODE INVALID', 'error');
    log(`Error: ${validation.error}`, 'error');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_invalid',
      message: validation.error,
      timestamp: new Date().toISOString()
    }));
    
    await delay(3000);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan QR code again',
      timestamp: new Date().toISOString()
    }));
  }
  
  state.processingQR = false;
}

/**
 * SIMPLE STDIN QR SCANNER USING READLINE
 */
function setupStdinQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - STDIN MODE');
  console.log('='.repeat(50));
  console.log('Ready for QR scanner input...');
  console.log('QR scanners work like keyboards - just scan!');
  console.log('Press Ctrl+C to exit');
  console.log('='.repeat(50) + '\n');
  
  state.qrScannerActive = true;
  
  // Create readline interface for clean input handling
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  
  // Handle each line of input (QR codes from scanner)
  rl.on('line', async (input) => {
    if (!state.qrScannerActive) return;
    
    const qrCode = input.trim();
    
    // Skip empty input
    if (!qrCode) return;
    
    // Check if system is ready for QR scan
    if (!state.isReady) {
      log('System not ready for QR scan', 'warning');
      return;
    }
    
    if (state.autoCycleEnabled) {
      log('Session already active, ignoring QR scan', 'warning');
      return;
    }
    
    if (state.processingQR) {
      log('Already processing QR code', 'warning');
      return;
    }
    
    console.log(`\n🔍 QR Code received: "${qrCode}"`);
    
    // Process the QR code
    await processQRCode(qrCode);
  });
  
  // Handle Ctrl+C
  rl.on('close', () => {
    log('QR scanner closed', 'info');
    state.qrScannerActive = false;
    gracefulShutdown();
  });
  
  log('STDIN QR Scanner ready - waiting for input...', 'success');
}

/**
 * Stop QR scanner
 */
function stopQRScanner() {
  log('Stopping QR scanner...', 'info');
  state.qrScannerActive = false;
  state.processingQR = false;
}

// ============================================
// HARDWARE CONTROL FUNCTIONS
// ============================================
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
  
  debugLog(`Executing: ${action} ${JSON.stringify(apiPayload)}`);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING MEMBER SESSION');
  console.log('='.repeat(50));
  
  state.isReady = false;
  stopQRScanner();
  
  log(`User: ${validationData.user.name}`, 'info');
  log(`Session: ${validationData.session.sessionCode}`, 'info');
  log(`Current Points: ${validationData.user.currentPoints || 0}`, 'info');
  console.log('='.repeat(50) + '\n');
  
  state.currentUserId = validationData.user.id;
  state.sessionId = validationData.session.sessionId;
  state.sessionCode = validationData.session.sessionCode;
  state.currentUserData = {
    name: validationData.user.name,
    email: validationData.user.email,
    currentPoints: validationData.user.currentPoints
  };
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  
  log('Resetting system...', 'info');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  
  if (state.compactorRunning) {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    if (state.compactorTimer) {
      clearTimeout(state.compactorTimer);
      state.compactorTimer = null;
    }
    state.compactorRunning = false;
  }
  
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  
  await executeCommand('calibrateWeight');
  await delay(1500);
  
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  log('Gate opened', 'success');
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'session_active',
    message: 'Insert your items',
    user: {
      name: validationData.user.name,
      currentPoints: validationData.user.currentPoints
    },
    timestamp: new Date().toISOString()
  }));
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    state.awaitingDetection = true;
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'session_active',
    event: 'session_started',
    sessionType: 'member',
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    timestamp: new Date().toISOString()
  }));
  
  log('Member session started!', 'success');
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 RESETTING FOR NEXT USER');
  console.log('='.repeat(50) + '\n');
  
  if (state.resetting) {
    log('Reset in progress', 'warning');
    return;
  }
  
  state.resetting = true;
  
  if (state.cycleInProgress) {
    log('Waiting for cycle...', 'info');
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(2000);
    }
  }
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.compactorRunning) {
      if (forceStop) {
        log('Force stopping compactor...', 'warning');
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
      } else {
        log('Waiting for compactor...', 'info');
        const maxWaitTime = CONFIG.timing.compactor + 2000;
        const startWait = Date.now();
        
        while (state.compactorRunning && (Date.now() - startWait) < maxWaitTime) {
          await delay(1000);
        }
        
        if (state.compactorRunning) {
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        }
      }
    }
    
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  }
  
  // Reset state
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.sessionCode = null;
  state.calibrationAttempts = 0;
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  state.itemsProcessed = 0;
  state.sessionStartTime = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  state.resetting = false;
  state.isReady = true;
  
  console.log('='.repeat(50));
  console.log('✅ SYSTEM READY FOR NEXT USER');
  console.log('='.repeat(50) + '\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'reset_complete',
    isReady: true,
    timestamp: new Date().toISOString()
  }));
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'ready_for_qr',
    message: 'Please scan your QR code',
    timestamp: new Date().toISOString()
  }));
  
  // Restart QR scanner for next user
  if (CONFIG.qr.enabled) {
    state.qrScannerActive = true;
    log('QR Scanner ready for next member', 'success');
  }
}

// ============================================
// MQTT & WEBSOCKET
// ============================================
function connectWebSocket() {
  log('Connecting to WebSocket...', 'info');
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('WebSocket connected', 'success');
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        log(`Module ID: ${state.moduleId}`, 'success');
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className,
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.awaitingDetection) {
          if (state.aiResult.materialType !== 'UNKNOWN') {
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            state.detectionRetries++;
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              setTimeout(() => executeCommand('takePhoto'), CONFIG.detection.retryDelay);
            } else {
              state.awaitingDetection = false;
              state.cycleInProgress = true;
              setTimeout(() => executeRejectionCycle(), 1000);
            }
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
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.aiResult && !state.cycleInProgress) {
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            state.aiResult = null;
            state.weight = null;
            state.awaitingDetection = false;
            
            if (state.autoPhotoTimer) {
              clearTimeout(state.autoPhotoTimer);
            }
            
            state.autoPhotoTimer = setTimeout(() => {
              if (!state.cycleInProgress && !state.awaitingDetection) {
                state.awaitingDetection = true;
                executeCommand('takePhoto');
              }
            }, CONFIG.timing.autoPhotoDelay);
            
            return;
          }
          
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }
      
    } catch (error) {
      log(`WS error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => {
    log(`WS connection error: ${error.message}`, 'error');
  });
  
  state.ws.on('close', () => {
    log('WS closed, reconnecting in 5s...', 'warning');
    setTimeout(connectWebSocket, 5000);
  });
}

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('MQTT connected', 'success');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      log(`Command: ${payload.action}`, 'info');
      
      if (payload.action === 'emergencyStop') {
        stopQRScanner();
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        
        if (state.compactorRunning) {
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        }
        
        state.autoCycleEnabled = false;
        state.cycleInProgress = false;
        state.resetting = false;
        state.isReady = false;
        return;
      }
      
      if (payload.action === 'forceReset') {
        stopQRScanner();
        state.cycleInProgress = false;
        state.resetting = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        stopQRScanner();
        await resetSystemForNextUser(false);
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => {
  log(`MQTT connection error: ${error.message}`, 'error');
});

// ============================================
// INITIALIZATION
// ============================================
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    log(`Module ID request failed: ${error.message}`, 'error');
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  stopQRScanner();
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  
  setTimeout(() => {
    mqttClient.end();
    log('Shutdown complete', 'success');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(50));
console.log('🚀 RVM AGENT - SIMPLE STDIN QR SCANNER');
console.log('='.repeat(50));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('⌨️  Simple STDIN QR Scanner');
console.log('✅ No complex buffer management');
console.log('✅ Clean readline input handling');
console.log('='.repeat(50) + '\n');

// Wait for module ID and start
setTimeout(() => {
  if (state.moduleId) {
    state.isReady = true;
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'startup_ready',
      isReady: true,
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
    
    // Start the simple stdin QR scanner
    setupStdinQRScanner();
    
    console.log('🟢 SYSTEM READY FOR QR SCANNING');
    console.log('💡 Just scan QR codes with your connected scanner!\n');
    
  } else {
    log('Module ID not received, retrying...', 'warning');
    requestModuleId();
  }
}, 3000);
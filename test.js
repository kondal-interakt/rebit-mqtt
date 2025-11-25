// agent-qr-global-improved.js - WITH HEARTBEAT & RELIABLE MODULE ID
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

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
      screenState: 'rvm/RVM-3101/screen/state',
      qrInput: 'rvm/RVM-3101/qr/input',
      guestStart: 'rvm/RVM-3101/guest/start'
    }
  },
  
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    scanTimeout: 200,
    debug: false
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
  
  // NEW: Heartbeat configuration
  heartbeat: {
    enabled: true,
    interval: 30000,        // Send heartbeat every 30 seconds
    timeout: 10000,         // Expect response within 10 seconds
    maxMissed: 3,           // Reconnect after 3 missed heartbeats
    moduleIdRetries: 5,     // Retry module ID acquisition 5 times
    moduleIdInterval: 3000  // Wait 3 seconds between retries
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
  
  // QR Scanner state
  qrBuffer: '',
  lastCharTime: 0,
  qrTimer: null,
  processingQR: false,
  qrScannerActive: false,
  globalKeyListener: null,
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  isGuestSession: false,
  itemsProcessed: 0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  
  // Hardware state
  compactorRunning: false,
  compactorTimer: null,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  
  // NEW: Heartbeat state
  heartbeatInterval: null,
  heartbeatTimeout: null,
  lastHeartbeatTime: 0,
  missedHeartbeats: 0,
  wsConnected: false,
  wsReconnecting: false,
  moduleIdAttempts: 0,
  moduleIdTimer: null
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

// ============================================
// HEARTBEAT FUNCTIONS
// ============================================

/**
 * Start WebSocket heartbeat mechanism
 */
function startHeartbeat() {
  if (!CONFIG.heartbeat.enabled) return;
  
  // Clear any existing heartbeat
  stopHeartbeat();
  
  log('💓 Starting WebSocket heartbeat', 'info');
  
  state.lastHeartbeatTime = Date.now();
  state.missedHeartbeats = 0;
  
  // Send heartbeat periodically
  state.heartbeatInterval = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      log('WebSocket not open, skipping heartbeat', 'warning');
      state.missedHeartbeats++;
      
      if (state.missedHeartbeats >= CONFIG.heartbeat.maxMissed) {
        log(`Missed ${state.missedHeartbeats} heartbeats, reconnecting...`, 'error');
        stopHeartbeat();
        reconnectWebSocket();
      }
      return;
    }
    
    const heartbeatData = {
      value: "heartbeat",
      method: "ping",
      timestamp: Date.now()
    };
    
    debugLog(`💓 Sending heartbeat: ${JSON.stringify(heartbeatData)}`);
    
    try {
      state.ws.send(JSON.stringify(heartbeatData));
      
      // Set timeout for heartbeat response
      if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
      }
      
      state.heartbeatTimeout = setTimeout(() => {
        state.missedHeartbeats++;
        log(`⚠️ Heartbeat timeout (missed: ${state.missedHeartbeats}/${CONFIG.heartbeat.maxMissed})`, 'warning');
        
        if (state.missedHeartbeats >= CONFIG.heartbeat.maxMissed) {
          log('Too many missed heartbeats, reconnecting...', 'error');
          stopHeartbeat();
          reconnectWebSocket();
        }
      }, CONFIG.heartbeat.timeout);
      
    } catch (error) {
      log(`Heartbeat send error: ${error.message}`, 'error');
      state.missedHeartbeats++;
      
      if (state.missedHeartbeats >= CONFIG.heartbeat.maxMissed) {
        stopHeartbeat();
        reconnectWebSocket();
      }
    }
    
  }, CONFIG.heartbeat.interval);
  
  log('✅ Heartbeat started', 'success');
}

/**
 * Stop heartbeat timers
 */
function stopHeartbeat() {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
  
  if (state.heartbeatTimeout) {
    clearTimeout(state.heartbeatTimeout);
    state.heartbeatTimeout = null;
  }
  
  debugLog('Heartbeat stopped');
}

/**
 * Handle heartbeat response (pong)
 */
function handleHeartbeatResponse(data) {
  state.lastHeartbeatTime = Date.now();
  state.missedHeartbeats = 0;
  
  if (state.heartbeatTimeout) {
    clearTimeout(state.heartbeatTimeout);
    state.heartbeatTimeout = null;
  }
  
  debugLog('💓 Heartbeat response received');
}

/**
 * Reconnect WebSocket with exponential backoff
 */
async function reconnectWebSocket() {
  if (state.wsReconnecting) {
    log('Reconnection already in progress', 'warning');
    return;
  }
  
  state.wsReconnecting = true;
  state.wsConnected = false;
  
  log('🔄 Reconnecting WebSocket...', 'info');
  
  if (state.ws) {
    try {
      state.ws.close();
    } catch (e) {
      // Ignore close errors
    }
    state.ws = null;
  }
  
  await delay(2000);
  
  state.wsReconnecting = false;
  connectWebSocket();
}

// ============================================
// MODULE ID ACQUISITION
// ============================================

/**
 * Request module ID with retry mechanism
 */
async function requestModuleId() {
  if (state.moduleId) {
    log(`Module ID already set: ${state.moduleId}`, 'info');
    return true;
  }
  
  state.moduleIdAttempts++;
  
  try {
    log(`📡 Requesting Module ID (attempt ${state.moduleIdAttempts}/${CONFIG.heartbeat.moduleIdRetries})`, 'info');
    
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    // Wait for module ID to arrive via WebSocket
    await delay(1000);
    
    if (state.moduleId) {
      log(`✅ Module ID received: ${state.moduleId}`, 'success');
      state.moduleIdAttempts = 0;
      return true;
    }
    
    // Module ID not received yet
    log(`Module ID not received yet (attempt ${state.moduleIdAttempts})`, 'warning');
    
    if (state.moduleIdAttempts < CONFIG.heartbeat.moduleIdRetries) {
      // Schedule retry
      if (state.moduleIdTimer) {
        clearTimeout(state.moduleIdTimer);
      }
      
      state.moduleIdTimer = setTimeout(() => {
        requestModuleId();
      }, CONFIG.heartbeat.moduleIdInterval);
      
      return false;
    } else {
      log('❌ Failed to get Module ID after max retries', 'error');
      log('⚠️ Check if local server is running and WebSocket is connected', 'warning');
      
      // Reset attempts and try again after longer delay
      state.moduleIdAttempts = 0;
      state.moduleIdTimer = setTimeout(() => {
        log('🔄 Retrying Module ID acquisition...', 'info');
        requestModuleId();
      }, 10000);
      
      return false;
    }
    
  } catch (error) {
    log(`Module ID request error: ${error.message}`, 'error');
    
    if (state.moduleIdAttempts < CONFIG.heartbeat.moduleIdRetries) {
      state.moduleIdTimer = setTimeout(() => {
        requestModuleId();
      }, CONFIG.heartbeat.moduleIdInterval);
    } else {
      state.moduleIdAttempts = 0;
      state.moduleIdTimer = setTimeout(() => {
        requestModuleId();
      }, 10000);
    }
    
    return false;
  }
}

/**
 * Initialize system once module ID is received
 */
async function initializeSystem() {
  if (!state.moduleId) {
    log('Cannot initialize - Module ID not set', 'error');
    return;
  }
  
  if (state.isReady) {
    log('System already initialized', 'info');
    return;
  }
  
  log('🚀 Initializing system...', 'info');
  
  state.isReady = true;
  
  // Start QR scanner
  setupSimpleQRScanner();
  
  // Publish ready status
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'startup_ready',
    isReady: true,
    qrScannerActive: state.qrScannerActive,
    moduleId: state.moduleId,
    timestamp: new Date().toISOString()
  }));
  
  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state: 'ready_for_qr',
    message: 'Please scan your QR code or click Start Recycling',
    timestamp: new Date().toISOString()
  }));
  
  console.log('\n' + '='.repeat(60));
  console.log('🟢 SYSTEM READY');
  console.log('='.repeat(60));
  console.log(`📱 QR Scanner: Active`);
  console.log(`🎫 Guest Button: Ready`);
  console.log(`🔌 Module ID: ${state.moduleId}`);
  console.log(`💓 Heartbeat: ${CONFIG.heartbeat.enabled ? 'Active' : 'Disabled'}`);
  console.log('💡 Both member and guest will receive points!');
  console.log('='.repeat(60) + '\n');
  
  // Run diagnostics after a short delay
  setTimeout(() => {
    runDiagnostics();
  }, 2000);
}

// ============================================
// DIAGNOSTIC FUNCTIONS
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 QR SCANNER & CONNECTION DIAGNOSTICS');
  console.log('='.repeat(60));
  
  console.log('\n1️⃣ Configuration:');
  console.log(`   QR Enabled: ${CONFIG.qr.enabled}`);
  console.log(`   Min Length: ${CONFIG.qr.minLength}`);
  console.log(`   Max Length: ${CONFIG.qr.maxLength}`);
  console.log(`   Scan Timeout: ${CONFIG.qr.scanTimeout}ms`);
  console.log(`   Debug Mode: ${CONFIG.qr.debug}`);
  
  console.log('\n2️⃣ WebSocket Status:');
  console.log(`   Connected: ${state.wsConnected}`);
  console.log(`   Ready State: ${state.ws ? state.ws.readyState : 'N/A'}`);
  console.log(`   Reconnecting: ${state.wsReconnecting}`);
  console.log(`   Last Heartbeat: ${state.lastHeartbeatTime ? new Date(state.lastHeartbeatTime).toLocaleTimeString() : 'N/A'}`);
  console.log(`   Missed Heartbeats: ${state.missedHeartbeats}/${CONFIG.heartbeat.maxMissed}`);
  
  console.log('\n3️⃣ Module ID Status:');
  console.log(`   Module ID: ${state.moduleId || 'NOT SET'}`);
  console.log(`   Acquisition Attempts: ${state.moduleIdAttempts}`);
  console.log(`   Max Retries: ${CONFIG.heartbeat.moduleIdRetries}`);
  
  console.log('\n4️⃣ System State:');
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   qrScannerActive: ${state.qrScannerActive}`);
  console.log(`   autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   processingQR: ${state.processingQR}`);
  console.log(`   globalKeyListener: ${state.globalKeyListener ? 'ACTIVE' : 'INACTIVE'}`);
  
  console.log('\n5️⃣ QR Buffer:');
  console.log(`   Current buffer: "${state.qrBuffer}"`);
  console.log(`   Buffer length: ${state.qrBuffer.length}`);
  console.log(`   Last char time: ${state.lastCharTime}`);
  console.log(`   QR timer active: ${state.qrTimer !== null}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('💡 TIP: Try scanning a QR code now...');
  console.log('💡 Scanner works in background - no focus needed!');
  console.log('='.repeat(60) + '\n');
}

function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = className.includes('易拉罐') || className.includes('铝');
  } 
  else if (className.includes('pet') || className.includes('plastic') || 
           className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet');
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
  }
  
  const confidencePercent = Math.round(probability * 100);
  const thresholdPercent = Math.round(threshold * 100);
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = threshold * 0.3;
    
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      log(`${materialType} detected via keyword match (${confidencePercent}% confidence, relaxed threshold)`, 'success');
      return materialType;
    }
    
    log(`${materialType} detected but confidence too low (${confidencePercent}% < ${thresholdPercent}%)`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`${materialType} detected (${confidencePercent}%)`, 'success');
  }
  
  return materialType;
}

// ============================================
// QR SCANNER - GLOBAL KEYBOARD HOOK
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
      log(`Session: ${response.data.session.sessionCode}`, 'info');
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
    debugLog('Already processing a QR code, skipping...');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR code length: ${cleanCode.length} chars (must be ${CONFIG.qr.minLength}-${CONFIG.qr.maxLength})`, 'error');
    return;
  }
  
  state.processingQR = true;
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR CODE SCANNED');
  console.log('='.repeat(50));
  console.log(`QR Code: ${cleanCode}`);
  console.log(`Length: ${cleanCode.length} chars`);
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
      message: 'Please scan your QR code again',
      timestamp: new Date().toISOString()
    }));
  }
  
  state.processingQR = false;
}

/**
 * Global keyboard hook - works in background
 */
function setupSimpleQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  // Prevent multiple scanners
  if (state.globalKeyListener) {
    log('QR scanner already active', 'warning');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - GLOBAL KEYBOARD HOOK');
  console.log('='.repeat(50));
  console.log('✅ Works in background!');
  console.log('✅ No window focus needed!');
  console.log('✅ Auto-detects QR completion');
  console.log('Press Ctrl+C to exit');
  console.log('='.repeat(50) + '\n');
  
  state.qrScannerActive = true;
  state.qrBuffer = '';
  state.lastCharTime = 0;
  
  const CONSOLE_PATTERNS = [
    /^C:\\/i,
    /^[A-Z]:\\/i,
    /operable program/i,
    /batch file/i,
    /Users\\/i,
    /\\rebit-mqtt/i,
    /node/i,
    /RVM AGENT/i
  ];
  
  function isConsoleOutput(text) {
    return CONSOLE_PATTERNS.some(pattern => pattern.test(text));
  }
  
  const gkl = new GlobalKeyboardListener();
  
  gkl.addListener((e, down) => {
    if (e.state !== 'DOWN') return;
    
    if (!state.qrScannerActive) return;
    
    if (!state.isReady || state.autoCycleEnabled || state.processingQR) {
      return;
    }
    
    const currentTime = Date.now();
    
    if (e.name === 'RETURN' || e.name === 'ENTER') {
      if (state.qrBuffer.length >= CONFIG.qr.minLength && 
          state.qrBuffer.length <= CONFIG.qr.maxLength) {
        
        if (isConsoleOutput(state.qrBuffer)) {
          debugLog(`Rejected console output: "${state.qrBuffer}"`);
          state.qrBuffer = '';
          return;
        }
        
        const qrCode = state.qrBuffer;
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        
        log(`✅ QR Code detected: ${qrCode}`, 'success');
        processQRCode(qrCode);
      } else {
        debugLog(`Buffer invalid length: ${state.qrBuffer.length}`);
        state.qrBuffer = '';
      }
      return;
    }
    
    const char = e.name;
    
    if (char.length === 1) {
      const timeDiff = currentTime - state.lastCharTime;
      
      if (timeDiff > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        debugLog(`Timeout, resetting buffer`);
        state.qrBuffer = '';
      }
      
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        debugLog(`Buffer overflow (${state.qrBuffer.length}), rejecting`);
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        return;
      }
      
      state.qrBuffer += char;
      debugLog(`Buffer: "${state.qrBuffer}" (${state.qrBuffer.length})`);
      state.lastCharTime = currentTime;
      
      if (state.qrTimer) {
        clearTimeout(state.qrTimer);
      }
      
      state.qrTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength && 
            state.qrBuffer.length <= CONFIG.qr.maxLength) {
          
          if (isConsoleOutput(state.qrBuffer)) {
            debugLog(`Auto-timeout rejected console: "${state.qrBuffer}"`);
            state.qrBuffer = '';
            state.qrTimer = null;
            return;
          }
          
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          log(`✅ QR Code auto-detected: ${qrCode}`, 'success');
          processQRCode(qrCode);
        } else {
          debugLog(`Auto-timeout invalid: ${state.qrBuffer.length} chars`);
          state.qrBuffer = '';
        }
        state.qrTimer = null;
      }, CONFIG.qr.scanTimeout);
    }
  });
  
  state.globalKeyListener = gkl;
  
  log('✅ QR Scanner ready with GLOBAL keyboard capture!', 'success');
  log('✅ Scanner works even when window is not in focus!', 'success');
}

/**
 * Stop QR scanner (pauses processing via state flags)
 */
function stopQRScanner() {
  if (!state.qrScannerActive) return;
  
  log('Pausing QR scanner...', 'info');
  state.qrScannerActive = false;
  state.processingQR = false;
  state.qrBuffer = '';
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  debugLog('QR scanner paused (listener still active)');
}

/**
 * Restart QR scanner
 */
function restartQRScanner() {
  if (!CONFIG.qr.enabled) return;
  
  state.qrScannerActive = true;
  state.processingQR = false;
  state.qrBuffer = '';
  state.lastCharTime = 0;
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  log('✅ QR Scanner restarted - ready for next scan', 'success');
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
// COMPACTOR & CYCLE FUNCTIONS
// ============================================
async function startCompactor() {
  if (state.compactorRunning) {
    log('Waiting for previous compactor cycle...', 'warning');
    const startWait = Date.now();
    
    while (state.compactorRunning && (Date.now() - startWait) < CONFIG.timing.compactor + 5000) {
      await delay(500);
    }
    
    if (state.compactorRunning) {
      log('Compactor timeout - forcing stop', 'warning');
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      state.compactorRunning = false;
    }
  }
  
  log('Starting Compactor', 'info');
  
  state.compactorRunning = true;
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  state.compactorTimer = setTimeout(async () => {
    log('Compactor finished', 'success');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
}

async function executeRejectionCycle() {
  console.log('\n' + '='.repeat(50));
  console.log('❌ REJECTION CYCLE');
  console.log('='.repeat(50) + '\n');

  try {
    log('Reversing belt to reject bin', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    log('Item rejected', 'success');

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
  }

  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;

  if (state.autoCycleEnabled) {
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  state.itemsProcessed++;
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n' + '='.repeat(50));
  console.log(`🤖 AUTO CYCLE - ITEM #${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');

  try {
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    await startCompactor();

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    resetInactivityTimer();

  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
  }

  state.aiResult = null;
  state.weight = null;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;

  if (state.autoCycleEnabled) {
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
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
  state.isMember = true;
  state.isGuestSession = false;
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  startSessionTimers();
  
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
    if (state.autoCycleEnabled) {
      state.awaitingDetection = true;
      executeCommand('takePhoto');
    }
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

async function startGuestSession(sessionData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING GUEST SESSION');
  console.log('='.repeat(50));
  
  state.isReady = false;
  stopQRScanner();
  
  log(`Session: ${sessionData.sessionCode}`, 'info');
  log(`Session ID: ${sessionData.sessionId}`, 'info');
  console.log('='.repeat(50) + '\n');
  
  state.currentUserId = null;
  state.sessionId = sessionData.sessionId;
  state.sessionCode = sessionData.sessionCode;
  state.currentUserData = null;
  state.isMember = false;
  state.isGuestSession = true;
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  startSessionTimers();
  
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
    sessionType: 'guest',
    timestamp: new Date().toISOString()
  }));
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(() => {
    if (state.autoCycleEnabled) {
      state.awaitingDetection = true;
      executeCommand('takePhoto');
    }
  }, CONFIG.timing.autoPhotoDelay);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'session_active',
    event: 'session_started',
    sessionType: 'guest',
    sessionId: state.sessionId,
    sessionCode: state.sessionCode,
    timestamp: new Date().toISOString()
  }));
  
  log('Guest session started!', 'success');
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
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  if (state.cycleInProgress) {
    log('Waiting for cycle...', 'info');
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(2000);
    }
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
  
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.sessionCode = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  state.itemsProcessed = 0;
  state.sessionStartTime = null;
  state.detectionRetries = 0;
  state.isMember = false;
  state.isGuestSession = false;
  
  clearSessionTimers();
  
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
  
  restartQRScanner();
}

// ============================================
// SESSION TIMER FUNCTIONS
// ============================================
async function handleSessionTimeout(reason) {
  console.log('\n' + '='.repeat(50));
  console.log('⏱️ SESSION TIMEOUT');
  console.log('='.repeat(50));
  console.log(`Reason: ${reason}`);
  console.log(`Items processed: ${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'timeout',
    event: 'session_timeout',
    reason: reason,
    itemsProcessed: state.itemsProcessed,
    timestamp: new Date().toISOString()
  }));
  
  if (state.cycleInProgress) {
    log('Waiting for current cycle...', 'info');
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(1000);
    }
  }
  
  await resetSystemForNextUser(false);
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
  }
  
  state.lastActivityTime = Date.now();
  
  state.sessionTimeoutTimer = setTimeout(() => {
    handleSessionTimeout('inactivity');
  }, CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
  }
  
  state.maxDurationTimer = setTimeout(() => {
    handleSessionTimeout('max_duration');
  }, CONFIG.timing.sessionMaxDuration);
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
    state.sessionTimeoutTimer = null;
  }
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
    state.maxDurationTimer = null;
  }
}

// ============================================
// MQTT & WEBSOCKET
// ============================================
function connectWebSocket() {
  log('🔌 Connecting to WebSocket...', 'info');
  
  // Clean up existing connection
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch (e) {
      // Ignore
    }
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('✅ WebSocket connected', 'success');
    state.wsConnected = true;
    state.wsReconnecting = false;
    state.missedHeartbeats = 0;
    
    // Start heartbeat
    startHeartbeat();
    
    // Request module ID if not set
    if (!state.moduleId) {
      setTimeout(() => {
        requestModuleId();
      }, 1000);
    }
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle heartbeat response (pong)
      if (message.method === 'pong' || message.value === 'pong') {
        handleHeartbeatResponse(message);
        return;
      }
      
      // Module ID response
      if (message.function === '01') {
        const newModuleId = message.moduleId;
        
        if (state.moduleId && state.moduleId !== newModuleId) {
          log(`⚠️ Module ID changed: ${state.moduleId} → ${newModuleId}`, 'warning');
        }
        
        state.moduleId = newModuleId;
        log(`✅ Module ID: ${state.moduleId}`, 'success');
        
        // Initialize system if not ready
        if (!state.isReady) {
          setTimeout(() => {
            initializeSystem();
          }, 1000);
        }
        
        return;
      }
      
      // AI Photo result
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
              setTimeout(() => {
                if (state.autoCycleEnabled) {
                  executeCommand('takePhoto');
                }
              }, CONFIG.detection.retryDelay);
            } else {
              state.awaitingDetection = false;
              state.cycleInProgress = true;
              setTimeout(() => executeRejectionCycle(), 1000);
            }
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
              if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
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
      log(`WS message error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => {
    log(`❌ WS connection error: ${error.message}`, 'error');
    state.wsConnected = false;
  });
  
  state.ws.on('close', (code, reason) => {
    log(`⚠️ WS closed (code: ${code}, reason: ${reason || 'none'})`, 'warning');
    state.wsConnected = false;
    
    // Stop heartbeat
    stopHeartbeat();
    
    if (!state.wsReconnecting) {
      log('Reconnecting in 5s...', 'info');
      setTimeout(() => {
        if (!state.wsConnected && !state.wsReconnecting) {
          reconnectWebSocket();
        }
      }, 5000);
    }
  });
}

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('✅ MQTT connected', 'success');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  // Connect WebSocket
  connectWebSocket();
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      console.log('\n' + '='.repeat(50));
      console.log('🎫 GUEST SESSION START (Button Click)');
      console.log('='.repeat(50));
      console.log(`📊 Current State:`);
      console.log(`   - isReady: ${state.isReady}`);
      console.log(`   - resetting: ${state.resetting}`);
      console.log(`   - qrScannerActive: ${state.qrScannerActive}`);
      console.log(`   - autoCycleEnabled: ${state.autoCycleEnabled}`);
      console.log('='.repeat(50) + '\n');
      
      if (state.resetting) {
        log('System currently resetting - Please try again', 'warning');
        mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
          deviceId: CONFIG.device.id,
          state: 'error',
          message: 'System resetting, please wait...',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (!state.isReady) {
        log('System not ready - Please try again', 'warning');
        mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
          deviceId: CONFIG.device.id,
          state: 'error',
          message: 'System not ready, please wait...',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (state.autoCycleEnabled) {
        log('Session already active - Ending previous session first', 'warning');
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      
      log('Starting guest session...', 'success');
      await startGuestSession(payload);
      return;
    }
    
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
        state.cycleInProgress = false;
        state.resetting = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'runDiagnostics') {
        runDiagnostics();
        return;
      }
      
      if (payload.action === 'reconnectWebSocket') {
        log('Manual WebSocket reconnect requested', 'info');
        reconnectWebSocket();
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
    if (topic === CONFIG.mqtt.topics.qrInput) {
      const { qrCode } = payload;
      
      if (state.isReady && !state.autoCycleEnabled && !state.processingQR) {
        log(`✅ QR Code received via MQTT: ${qrCode}`, 'success');
        processQRCode(qrCode);
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
// SHUTDOWN & ERROR HANDLING
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  stopQRScanner();
  stopHeartbeat();
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  if (state.moduleIdTimer) {
    clearTimeout(state.moduleIdTimer);
  }
  
  clearSessionTimers();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {
      // Ignore
    }
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) {
    try {
      state.ws.close();
    } catch (e) {
      // Ignore
    }
  }
  
  setTimeout(() => {
    mqttClient.end();
    log('Shutdown complete', 'success');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  console.error(error);
  gracefulShutdown();
});

process.on('unhandledRejection', (error) => {
  log(`Unhandled rejection: ${error.message}`, 'error');
  console.error(error);
});

// ============================================
// STARTUP SEQUENCE
// ============================================
console.log('='.repeat(60));
console.log('🚀 RVM AGENT - WITH HEARTBEAT & RELIABLE MODULE ID');
console.log('='.repeat(60));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Member: QR code scan → Track user + points');
console.log('✅ Guest: Button click → Track session + points');
console.log('✅ Background QR scanning enabled');
console.log('✅ No window focus needed!');
console.log('💓 WebSocket heartbeat: Every 30 seconds');
console.log('🔄 Auto-reconnect on connection loss');
console.log('📡 Reliable module ID acquisition with retries');
console.log('='.repeat(60) + '\n');

log('🚀 Agent starting...', 'info');
log('Waiting for MQTT and WebSocket connections...', 'info');
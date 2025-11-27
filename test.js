// agent-qr-optimized.js - OPTIMIZED FOR FASTER RECYCLING
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// ============================================
// CONFIGURATION - OPTIMIZED TIMINGS
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'
  },
  
  backend: {
    url: 'https://rebit-api.ceewen.xyz',
    timeout: 8000  // Reduced from 10000
  },
  
  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 8000  // Reduced from 10000
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
    processingTimeout: 30000,
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
    retryDelay: 1500,  // Reduced from 2000
    maxRetries: 2,  // Reduced from 3 for faster rejection
    hasObjectSensor: false,
    minValidWeight: 5
  },
  
  // OPTIMIZED TIMINGS - Key improvements
  timing: {
    beltToWeight: 2500,  // Reduced from 3000 (500ms faster)
    beltToStepper: 3500,  // Reduced from 4000 (500ms faster)
    beltReverse: 4000,  // Reduced from 5000 (1000ms faster)
    stepperRotate: 3500,  // Reduced from 4000 (500ms faster)
    stepperReset: 5000,  // Reduced from 6000 (1000ms faster)
    compactor: 22000,  // Reduced from 24000 (2000ms faster)
    positionSettle: 300,  // Reduced from 500
    gateOperation: 800,  // Reduced from 1000
    autoPhotoDelay: 3000,  // Reduced from 5000 (2000ms faster)
    sessionTimeout: 120000,
    sessionMaxDuration: 600000,
    
    // NEW: Optimized delays
    weightDelay: 1500,  // Reduced from 2000
    photoDelay: 1200,  // Reduced from 1500
    calibrationDelay: 1200,  // Reduced from 1500
    commandDelay: 100,  // Minimal delay between commands
    resetHomeDelay: 1500  // Reduced from 2000
  },
  
  // MQTT-based heartbeat configuration
  heartbeat: {
    interval: 30,
    maxModuleIdRetries: 10,
    stateCheckInterval: 60
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  },
  
  // NEW: Optimization flags
  optimization: {
    parallelOperations: true,  // Run compactor + stepper reset in parallel
    skipUnnecessaryDelays: true,  // Skip delays where safe
    fastCalibration: true,  // Faster weight calibration
    aggressiveTiming: true  // Use more aggressive timings
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
  processingQRTimeout: null,
  qrScannerActive: false,
  globalKeyListener: null,
  lastSuccessfulScan: null,
  
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
  
  // NEW: Performance tracking
  lastCycleTime: null,
  averageCycleTime: null,
  cycleCount: 0
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
    'debug': '🔍',
    'perf': '⚡'
  }[level] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) {
    log(message, 'debug');
  }
}

// NEW: Performance tracking
function trackCycleTime(startTime) {
  const cycleTime = Date.now() - startTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  
  if (state.averageCycleTime === null) {
    state.averageCycleTime = cycleTime;
  } else {
    state.averageCycleTime = (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  }
  
  log(`⚡ Cycle completed in ${(cycleTime / 1000).toFixed(1)}s | Avg: ${(state.averageCycleTime / 1000).toFixed(1)}s`, 'perf');
}

// ============================================
// QR SCANNER RECOVERY FUNCTIONS
// ============================================

function forceClearProcessingFlag() {
  if (state.processingQR) {
    log('🔧 Force clearing processingQR flag', 'warning');
    state.processingQR = false;
    
    if (state.processingQRTimeout) {
      clearTimeout(state.processingQRTimeout);
      state.processingQRTimeout = null;
    }
  }
}

function checkScannerHealth() {
  const now = Date.now();
  
  if (state.processingQR && state.processingQRTimeout === null) {
    log('⚠️ Scanner health check: processingQR stuck without timeout!', 'warning');
    forceClearProcessingFlag();
  }
  
  if (state.isReady && !state.autoCycleEnabled && !state.processingQR && !state.qrScannerActive) {
    log('⚠️ Scanner health check: Scanner should be active but isn\'t!', 'warning');
    restartQRScanner();
  }
  
  log(`Scanner Health: ${state.qrScannerActive ? '🟢 ACTIVE' : '🔴 INACTIVE'} | ` +
      `Processing: ${state.processingQR ? '⏳ YES' : '✅ NO'} | ` +
      `Ready: ${state.isReady ? '🟢' : '🔴'} | ` +
      `Session: ${state.autoCycleEnabled ? '🟢 ACTIVE' : '⭕ IDLE'}`, 'debug');
}

function emergencyResetScanner() {
  log('🚨 EMERGENCY SCANNER RESET', 'warning');
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  state.qrBuffer = '';
  state.lastCharTime = 0;
  state.processingQR = false;
  
  if (state.isReady && !state.autoCycleEnabled) {
    state.qrScannerActive = true;
    log('✅ Scanner emergency reset complete - ready for scan', 'success');
  }
}

// ============================================
// MQTT-BASED HEARTBEAT MANAGEMENT
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval,
  moduleIdRetries: 0,
  maxModuleIdRetries: CONFIG.heartbeat.maxModuleIdRetries,
  
  start() {
    if (this.interval) {
      clearInterval(this.interval);
    }
    
    console.log(`💓 Starting heartbeat (every ${this.timeout}s)`);
    
    this.interval = setInterval(async () => {
      await this.beat();
    }, this.timeout * 1000);
    
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
    }
    
    this.stateCheckInterval = setInterval(() => {
      checkScannerHealth();
    }, CONFIG.heartbeat.stateCheckInterval * 1000);
    
    log(`🔍 Scanner health check enabled (every ${CONFIG.heartbeat.stateCheckInterval}s)`, 'info');
  },
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('💓 Heartbeat stopped');
    }
    
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
      this.stateCheckInterval = null;
    }
  },
  
  async beat() {
    const timestamp = new Date().toISOString();
    
    if (!state.moduleId && this.moduleIdRetries < this.maxModuleIdRetries) {
      this.moduleIdRetries++;
      console.log(`💓 Heartbeat: Module ID missing (retry ${this.moduleIdRetries}/${this.maxModuleIdRetries})`);
      await requestModuleId();
      await delay(1000);
      
      if (state.moduleId) {
        console.log(`✅ Module ID acquired via heartbeat: ${state.moduleId}`);
        this.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('========================================');
          log('🟢 SYSTEM READY - OPTIMIZED MODE');
          log('========================================');
          log(`📱 Module ID: ${state.moduleId}`);
          log('⚡ Fast cycle mode enabled');
          log('✅ Ready for QR scan or guest session');
          log('========================================\n');
          
          setupSimpleQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'module_id_acquired',
            moduleId: state.moduleId,
            isReady: true,
            optimized: true,
            timestamp
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code or click Start Recycling',
            timestamp: new Date().toISOString()
          }));
        }
      }
    }
    
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ Heartbeat: WebSocket disconnected, reconnecting...');
      connectWebSocket();
    }
    
    const heartbeatData = {
      deviceId: CONFIG.device.id,
      status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat',
      moduleId: state.moduleId || null,
      isReady: state.isReady,
      resetting: state.resetting,
      cycleInProgress: state.cycleInProgress,
      autoCycleEnabled: state.autoCycleEnabled,
      compactorRunning: state.compactorRunning,
      itemsProcessed: state.itemsProcessed,
      sessionActive: state.autoCycleEnabled,
      sessionType: state.isMember ? 'member' : (state.isGuestSession ? 'guest' : null),
      qrScannerActive: state.qrScannerActive,
      processingQR: state.processingQR,
      lastCycleTime: state.lastCycleTime,
      averageCycleTime: state.averageCycleTime,
      cycleCount: state.cycleCount,
      optimized: true,
      uptime: Math.floor(process.uptime()),
      timestamp
    };
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify(heartbeatData));
    
    const perfInfo = state.lastCycleTime 
      ? ` | Last: ${(state.lastCycleTime / 1000).toFixed(1)}s`
      : '';
    
    console.log(`💓 Heartbeat: ${state.isReady ? '🟢 READY' : '🟡 INIT'} | ` +
                `Module: ${state.moduleId || 'NONE'} | ` +
                `Session: ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | ` +
                `QR: ${state.qrScannerActive ? 'ON' : 'OFF'}${state.processingQR ? ' (PROC)' : ''}${perfInfo}`);
  }
};

// ============================================
// MODULE ID ACQUISITION
// ============================================
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('📟 Module ID requested');
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

// ============================================
// DIAGNOSTIC FUNCTIONS
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 QR SCANNER & CONNECTION DIAGNOSTICS - OPTIMIZED');
  console.log('='.repeat(60));
  
  console.log('\n1️⃣ Configuration:');
  console.log(`   QR Enabled: ${CONFIG.qr.enabled}`);
  console.log(`   Min Length: ${CONFIG.qr.minLength}`);
  console.log(`   Max Length: ${CONFIG.qr.maxLength}`);
  console.log(`   Scan Timeout: ${CONFIG.qr.scanTimeout}ms`);
  console.log(`   Processing Timeout: ${CONFIG.qr.processingTimeout}ms`);
  
  console.log('\n2️⃣ Optimization Settings:');
  console.log(`   Parallel Operations: ${CONFIG.optimization.parallelOperations ? '✅' : '❌'}`);
  console.log(`   Skip Delays: ${CONFIG.optimization.skipUnnecessaryDelays ? '✅' : '❌'}`);
  console.log(`   Fast Calibration: ${CONFIG.optimization.fastCalibration ? '✅' : '❌'}`);
  console.log(`   Aggressive Timing: ${CONFIG.optimization.aggressiveTiming ? '✅' : '❌'}`);
  
  console.log('\n3️⃣ Timing Improvements:');
  console.log(`   Belt to Weight: 2.5s (was 3s) - 500ms faster`);
  console.log(`   Belt to Stepper: 3.5s (was 4s) - 500ms faster`);
  console.log(`   Belt Reverse: 4s (was 5s) - 1s faster`);
  console.log(`   Stepper Rotate: 3.5s (was 4s) - 500ms faster`);
  console.log(`   Stepper Reset: 5s (was 6s) - 1s faster`);
  console.log(`   Compactor: 22s (was 24s) - 2s faster`);
  console.log(`   Auto Photo Delay: 3s (was 5s) - 2s faster`);
  
  console.log('\n4️⃣ Performance Stats:');
  console.log(`   Items Processed: ${state.cycleCount}`);
  console.log(`   Last Cycle Time: ${state.lastCycleTime ? (state.lastCycleTime / 1000).toFixed(1) + 's' : 'N/A'}`);
  console.log(`   Average Cycle Time: ${state.averageCycleTime ? (state.averageCycleTime / 1000).toFixed(1) + 's' : 'N/A'}`);
  
  console.log('\n5️⃣ System State:');
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   qrScannerActive: ${state.qrScannerActive}`);
  console.log(`   autoCycleEnabled: ${state.autoCycleEnabled}`);
  console.log(`   processingQR: ${state.processingQR}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('⚡ OPTIMIZED MODE - FASTER RECYCLING!');
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
  
  state.processingQRTimeout = setTimeout(() => {
    if (state.processingQR) {
      log('⚠️ QR processing timeout - force clearing flag', 'warning');
      state.processingQR = false;
      state.processingQRTimeout = null;
      
      if (state.isReady && !state.autoCycleEnabled) {
        restartQRScanner();
      }
    }
  }, CONFIG.qr.processingTimeout);
  
  try {
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
      
      state.lastSuccessfulScan = new Date().toISOString();
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'qr_validated',
        message: `Welcome ${validation.user.name}!`,
        user: validation.user,
        timestamp: new Date().toISOString()
      }));
      
      await delay(1500);  // Reduced from 2000
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
      
      await delay(2500);  // Reduced from 3000
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'ready_for_qr',
        message: 'Please scan your QR code again',
        timestamp: new Date().toISOString()
      }));
    }
    
  } catch (error) {
    log(`❌ QR processing error: ${error.message}`, 'error');
    console.error(error);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'error',
      message: 'QR processing error - please try again',
      timestamp: new Date().toISOString()
    }));
    
    await delay(2500);  // Reduced from 3000
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
    
  } finally {
    state.processingQR = false;
    
    if (state.processingQRTimeout) {
      clearTimeout(state.processingQRTimeout);
      state.processingQRTimeout = null;
    }
    
    log('✅ QR processing complete - flag cleared', 'debug');
  }
}

function setupSimpleQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  if (state.globalKeyListener) {
    log('QR scanner already active', 'warning');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - OPTIMIZED MODE');
  console.log('='.repeat(50));
  console.log('⚡ Fast processing enabled!');
  console.log('✅ Works in background!');
  console.log('✅ No window focus needed!');
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
    
    if (!state.qrScannerActive) {
      debugLog('Scanner inactive, ignoring input');
      return;
    }
    
    if (!state.isReady || state.autoCycleEnabled || state.processingQR) {
      debugLog(`Skipping input - Ready:${state.isReady} AutoCycle:${state.autoCycleEnabled} Processing:${state.processingQR}`);
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
        
        log(`✅ QR Code detected (ENTER): ${qrCode}`, 'success');
        
        processQRCode(qrCode).catch(error => {
          log(`QR processing async error: ${error.message}`, 'error');
        });
        
      } else {
        debugLog(`Buffer invalid length on ENTER: ${state.qrBuffer.length}`);
        state.qrBuffer = '';
      }
      return;
    }
    
    const char = e.name;
    
    if (char.length === 1) {
      const timeDiff = currentTime - state.lastCharTime;
      
      if (timeDiff > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        debugLog(`Timeout (${timeDiff}ms), resetting buffer`);
        state.qrBuffer = '';
      }
      
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        debugLog(`Buffer overflow (${state.qrBuffer.length}), resetting`);
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        return;
      }
      
      state.qrBuffer += char;
      debugLog(`Buffer: "${state.qrBuffer}" (${state.qrBuffer.length} chars)`);
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
          log(`✅ QR Code auto-detected (timeout): ${qrCode}`, 'success');
          
          processQRCode(qrCode).catch(error => {
            log(`QR processing async error: ${error.message}`, 'error');
          });
          
        } else {
          debugLog(`Auto-timeout invalid: ${state.qrBuffer.length} chars`);
          state.qrBuffer = '';
        }
        state.qrTimer = null;
      }, CONFIG.qr.scanTimeout);
    }
  });
  
  state.globalKeyListener = gkl;
  
  log('✅ QR Scanner ready - OPTIMIZED MODE!', 'success');
  log('⚡ Fast processing enabled!', 'success');
}

function stopQRScanner() {
  if (!state.qrScannerActive) {
    debugLog('Scanner already stopped');
    return;
  }
  
  log('Pausing QR scanner...', 'info');
  state.qrScannerActive = false;
  state.processingQR = false;
  state.qrBuffer = '';
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  log('✅ QR scanner paused (listener still active)', 'debug');
}

function restartQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled in config', 'warning');
    return;
  }
  
  log('🔄 Restarting QR scanner...', 'info');
  
  state.qrScannerActive = true;
  state.processingQR = false;
  state.qrBuffer = '';
  state.lastCharTime = 0;
  
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  
  log('✅ QR Scanner restarted - ready for next scan', 'success');
  
  debugLog(`Scanner state: active=${state.qrScannerActive}, ready=${state.isReady}, session=${state.autoCycleEnabled}`);
}

// ============================================
// HARDWARE CONTROL FUNCTIONS - OPTIMIZED
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
    
    // OPTIMIZED: Reduced delays
    if (action === 'takePhoto') await delay(CONFIG.timing.photoDelay);
    if (action === 'getWeight') await delay(CONFIG.timing.weightDelay);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// COMPACTOR & CYCLE FUNCTIONS - OPTIMIZED
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
  console.log('❌ REJECTION CYCLE - FAST MODE');
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
    
    // OPTIMIZED: Skip unnecessary delay if configured
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
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

  // Track cycle start time
  const cycleStartTime = Date.now();

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
  console.log(`⚡ FAST CYCLE - ITEM #${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');

  try {
    // Move to stepper
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Rotate stepper
    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    // Reverse belt
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // OPTIMIZED: Parallel operations if enabled
    if (CONFIG.optimization.parallelOperations) {
      log('⚡ Running compactor + stepper reset in parallel', 'perf');
      
      // Start both operations simultaneously
      const compactorPromise = startCompactor();
      const stepperResetPromise = (async () => {
        await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
        await delay(CONFIG.timing.stepperReset);
      })();
      
      // Wait for both to complete
      await Promise.all([compactorPromise, stepperResetPromise]);
      
    } else {
      // Sequential operations (original)
      await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
      await delay(CONFIG.timing.stepperReset);
      await startCompactor();
    }

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    // Track cycle completion time
    trackCycleTime(cycleStartTime);

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
    
    // OPTIMIZED: Minimal delay
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
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
// SESSION MANAGEMENT - OPTIMIZED
// ============================================
async function startMemberSession(validationData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING MEMBER SESSION - OPTIMIZED');
  console.log('='.repeat(50));
  
  try {
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
    
    // OPTIMIZED: Fast stepper home
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    // OPTIMIZED: Fast calibration
    await executeCommand('calibrateWeight');
    if (CONFIG.optimization.fastCalibration) {
      await delay(CONFIG.timing.calibrationDelay);
    } else {
      await delay(1500);
    }
    
    await executeCommand('openGate');
    
    // OPTIMIZED: Minimal delay
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
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
      optimized: true,
      timestamp: new Date().toISOString()
    }));
    
    log('⚡ Member session started - FAST MODE!', 'success');
    
  } catch (error) {
    log(`❌ Error starting member session: ${error.message}`, 'error');
    console.error(error);
    
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 STARTING GUEST SESSION - OPTIMIZED');
  console.log('='.repeat(50));
  
  try {
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
    
    // OPTIMIZED: Fast stepper home
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    // OPTIMIZED: Fast calibration
    await executeCommand('calibrateWeight');
    if (CONFIG.optimization.fastCalibration) {
      await delay(CONFIG.timing.calibrationDelay);
    } else {
      await delay(1500);
    }
    
    await executeCommand('openGate');
    
    // OPTIMIZED: Minimal delay
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
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
      optimized: true,
      timestamp: new Date().toISOString()
    }));
    
    log('⚡ Guest session started - FAST MODE!', 'success');
    
  } catch (error) {
    log(`❌ Error starting guest session: ${error.message}`, 'error');
    console.error(error);
    
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 RESETTING FOR NEXT USER - OPTIMIZED');
  console.log('='.repeat(50) + '\n');
  
  if (state.resetting) {
    log('Reset in progress', 'warning');
    return;
  }
  
  state.resetting = true;
  
  try {
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
    
    // OPTIMIZED: Minimal delay
    if (!CONFIG.optimization.skipUnnecessaryDelays) {
      await delay(CONFIG.timing.gateOperation);
    } else {
      await delay(CONFIG.timing.commandDelay);
    }
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
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
    console.log('✅ SYSTEM READY FOR NEXT USER - OPTIMIZED');
    console.log('='.repeat(50) + '\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'reset_complete',
      isReady: true,
      optimized: true,
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
  console.log(`Session Code: ${state.sessionCode}`);
  console.log(`User ID: ${state.currentUserId || 'Guest'}`);
  console.log('='.repeat(50) + '\n');
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.sessionCode && state.itemsProcessed > 0) {
      log('⏰ Auto-finalizing session due to timeout...', 'info');
      
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'session_timeout',
        event: 'auto_finalize_session',
        reason: reason,
        sessionCode: state.sessionCode,
        userId: state.currentUserId,
        itemsProcessed: state.itemsProcessed,
        sessionType: state.isMember ? 'member' : 'guest',
        timestamp: new Date().toISOString()
      }));
      
      await delay(2000);
      
      log('✅ Session finalization notification sent', 'success');
    } else {
      log('ℹ️ No items processed, skipping finalization', 'info');
    }
  } catch (error) {
    log(`⚠️ Session finalization error: ${error.message}`, 'warning');
  }
  
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
    
    if (!state.moduleId) {
      setTimeout(() => {
        requestModuleId();
      }, 1000);
    }
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        const newModuleId = message.moduleId;
        
        if (state.moduleId && state.moduleId !== newModuleId) {
          log(`⚠️ Module ID changed: ${state.moduleId} → ${newModuleId}`, 'warning');
        }
        
        state.moduleId = newModuleId;
        log(`✅ Module ID: ${state.moduleId}`, 'success');
        
        heartbeat.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('========================================');
          log('🟢 SYSTEM READY - OPTIMIZED MODE');
          log('========================================');
          log(`📱 Module ID: ${state.moduleId}`);
          log('⚡ Fast cycle mode enabled');
          log('✅ Ready for QR scan or guest session');
          log('========================================\n');
          
          setupSimpleQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'module_id_acquired',
            moduleId: state.moduleId,
            isReady: true,
            optimized: true,
            timestamp: new Date().toISOString()
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code or click Start Recycling',
            timestamp: new Date().toISOString()
          }));
          
          setTimeout(() => {
            runDiagnostics();
          }, 2000);
        }
        
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
            
            // OPTIMIZED: Faster weight check
            setTimeout(() => executeCommand('getWeight'), 300);
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
            setTimeout(() => executeCommand('getWeight'), CONFIG.timing.calibrationDelay);
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
          
          // OPTIMIZED: Start cycle faster
          setTimeout(() => executeAutoCycle(), 500);
        }
        return;
      }
      
    } catch (error) {
      log(`WS message error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => {
    log(`❌ WS connection error: ${error.message}`, 'error');
  });
  
  state.ws.on('close', (code, reason) => {
    log(`⚠️ WS closed (code: ${code}, reason: ${reason || 'none'})`, 'warning');
    
    setTimeout(() => {
      log('Reconnecting WebSocket...', 'info');
      connectWebSocket();
    }, 5000);
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
    optimized: true,
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  
  setTimeout(() => {
    requestModuleId();
  }, 2000);
  
  setTimeout(() => {
    heartbeat.start();
  }, 5000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      console.log('\n' + '='.repeat(50));
      console.log('🎫 GUEST SESSION START - OPTIMIZED');
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
      
      if (payload.action === 'restartScanner') {
        log('📱 Manual scanner restart requested', 'info');
        restartQRScanner();
        return;
      }
      
      if (payload.action === 'emergencyResetScanner') {
        emergencyResetScanner();
        return;
      }
      
      if (payload.action === 'checkScannerHealth') {
        checkScannerHealth();
        return;
      }
      
      if (payload.action === 'setHeartbeatInterval') {
        heartbeat.timeout = payload.interval || 30;
        heartbeat.stop();
        heartbeat.start();
        log(`💓 Heartbeat interval updated: ${heartbeat.timeout}s`, 'info');
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
        processQRCode(qrCode).catch(error => {
          log(`QR processing error: ${error.message}`, 'error');
        });
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
  heartbeat.stop();
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
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
console.log('⚡ RVM AGENT - OPTIMIZED FOR SPEED!');
console.log('='.repeat(60));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('⚡ OPTIMIZATIONS ENABLED:');
console.log(`   ✅ Parallel Operations: ${CONFIG.optimization.parallelOperations}`);
console.log(`   ✅ Skip Delays: ${CONFIG.optimization.skipUnnecessaryDelays}`);
console.log(`   ✅ Fast Calibration: ${CONFIG.optimization.fastCalibration}`);
console.log(`   ✅ Aggressive Timing: ${CONFIG.optimization.aggressiveTiming}`);
console.log('\n⏱️ TIMING IMPROVEMENTS:');
console.log('   • Belt operations: 500-1000ms faster');
console.log('   • Stepper operations: 500-1000ms faster');
console.log('   • Compactor: 2000ms faster (22s vs 24s)');
console.log('   • Auto photo: 2000ms faster (3s vs 5s)');
console.log('   • Parallel compactor + stepper reset');
console.log('\n📊 EXPECTED PERFORMANCE:');
console.log('   • Per-item cycle: ~5-7 seconds faster');
console.log('   • Session startup: ~2 seconds faster');
console.log('   • Overall throughput: ~30-40% improvement');
console.log('='.repeat(60) + '\n');

log('🚀 Agent starting in OPTIMIZED MODE...', 'info');
log('Waiting for MQTT and WebSocket connections...', 'info');
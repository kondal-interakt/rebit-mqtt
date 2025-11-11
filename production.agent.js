// agent-production.js - Industry Standard RVM Agent
// Includes: Health Monitoring, Error Codes, Watchdog, Data Persistence, Parallel Compactor

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');

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
      guestStart: 'rvm/RVM-3101/guest/start',
      screenState: 'rvm/RVM-3101/screen/state',
      health: 'rvm/RVM-3101/health',
      errors: 'rvm/RVM-3101/errors',
      watchdog: 'rvm/RVM-3101/watchdog'
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
    GLASS: 0.25,
    retryDelay: 2000,
    maxRetries: 3,
    minValidWeight: 5
  },
  
  timing: {
    beltToWeight: 3000,
    beltToStepper: 4000,
    beltReverse: 5000,
    stepperRotate: 4000,
    stepperReset: 6000,
    compactor: 24000,
    gateOperation: 1000,
    autoPhotoDelay: 5000,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000
  },
  
  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  },
  
  health: {
    heartbeatInterval: 5000,
    publishInterval: 30000
  },
  
  watchdog: {
    checkInterval: 30000,
    activityTimeout: 120000,
    criticalTimeout: 300000,
    enabled: true
  }
};

// ============================================
// ERROR CODES
// ============================================
const ERROR_CODES = {
  // Hardware Errors
  E001: { severity: 'CRITICAL', category: 'HARDWARE', message: 'Motor jam detected' },
  E002: { severity: 'CRITICAL', category: 'HARDWARE', message: 'Gate malfunction' },
  E003: { severity: 'ERROR', category: 'HARDWARE', message: 'Stepper motor timeout' },
  E004: { severity: 'CRITICAL', category: 'HARDWARE', message: 'Compactor motor failure' },
  
  // Sensor Errors
  E101: { severity: 'WARNING', category: 'SENSOR', message: 'Weight sensor needs calibration' },
  E102: { severity: 'ERROR', category: 'SENSOR', message: 'Weight sensor failure' },
  E103: { severity: 'ERROR', category: 'SENSOR', message: 'Camera connection lost' },
  
  // AI/Detection Errors
  E201: { severity: 'WARNING', category: 'DETECTION', message: 'Low confidence detection' },
  E202: { severity: 'ERROR', category: 'DETECTION', message: 'AI service timeout' },
  E203: { severity: 'WARNING', category: 'DETECTION', message: 'Multiple detection retries' },
  
  // Communication Errors
  E301: { severity: 'CRITICAL', category: 'COMMUNICATION', message: 'MQTT connection lost' },
  E302: { severity: 'CRITICAL', category: 'COMMUNICATION', message: 'WebSocket disconnected' },
  E303: { severity: 'ERROR', category: 'COMMUNICATION', message: 'Backend API timeout' },
  
  // Operational Errors
  E401: { severity: 'CRITICAL', category: 'OPERATIONAL', message: 'Bin full' },
  E402: { severity: 'ERROR', category: 'OPERATIONAL', message: 'Cycle timeout' },
  E403: { severity: 'WARNING', category: 'OPERATIONAL', message: 'Session timeout' },
  
  // System Errors
  E501: { severity: 'CRITICAL', category: 'SYSTEM', message: 'Watchdog timeout' },
  E502: { severity: 'ERROR', category: 'SYSTEM', message: 'Memory usage critical' },
  E503: { severity: 'ERROR', category: 'SYSTEM', message: 'Database error' },
  E504: { severity: 'ERROR', category: 'SYSTEM', message: 'Module ID not available' }
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
  
  // Compactor tracking
  compactorRunning: false,
  compactorTimer: null,
  
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
  autoPhotoTimer: null,
  
  // Detection retry tracking
  detectionRetries: 0,
  awaitingDetection: false,
  
  // Health tracking
  health: {
    lastHeartbeat: Date.now(),
    uptime: 0,
    totalCycles: 0,
    errorCount: 0,
    systemVitals: {
      cpuUsage: 0,
      memoryUsage: 0
    }
  }
};

// ============================================
// DATABASE INITIALIZATION
// ============================================
let db = null;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database('./rvm-data.db', (err) => {
      if (err) {
        logError('E503', { error: err.message, action: 'database_init' });
        reject(err);
        return;
      }
      
      console.log('📦 Database connected');
      
      db.serialize(() => {
        // Sessions table
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_code TEXT NOT NULL,
          session_id TEXT,
          user_id TEXT,
          user_name TEXT,
          is_guest INTEGER DEFAULT 0,
          start_time TEXT NOT NULL,
          end_time TEXT,
          items_processed INTEGER DEFAULT 0,
          total_weight REAL DEFAULT 0,
          synced INTEGER DEFAULT 0,
          synced_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Items table
        db.run(`CREATE TABLE IF NOT EXISTS items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_code TEXT NOT NULL,
          material_type TEXT NOT NULL,
          weight REAL NOT NULL,
          ai_confidence INTEGER,
          ai_class_name TEXT,
          processed_time TEXT NOT NULL,
          synced INTEGER DEFAULT 0,
          synced_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Rejections table
        db.run(`CREATE TABLE IF NOT EXISTS rejections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_code TEXT,
          reason TEXT NOT NULL,
          ai_confidence INTEGER,
          ai_class_name TEXT,
          rejected_time TEXT NOT NULL,
          synced INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Errors table
        db.run(`CREATE TABLE IF NOT EXISTS errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          error_code TEXT NOT NULL,
          severity TEXT NOT NULL,
          category TEXT NOT NULL,
          message TEXT NOT NULL,
          details TEXT,
          error_time TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Indexes
        db.run('CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(session_code)');
        db.run('CREATE INDEX IF NOT EXISTS idx_items_session ON items(session_code)');
        db.run('CREATE INDEX IF NOT EXISTS idx_items_synced ON items(synced)');
        db.run('CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced)');
        
        console.log('✅ Database initialized\n');
        resolve();
      });
    });
  });
}

// Database functions
function saveSessionStart(sessionData) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO sessions (session_code, session_id, user_id, user_name, is_guest, start_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    sessionData.sessionCode,
    sessionData.sessionId || null,
    sessionData.userId || null,
    sessionData.userName || null,
    sessionData.isGuest ? 1 : 0,
    new Date().toISOString()
  );
  stmt.finalize();
}

function saveSessionEnd(sessionCode, itemsProcessed, totalWeight) {
  if (!db) return;
  const stmt = db.prepare(`
    UPDATE sessions 
    SET end_time = ?, items_processed = ?, total_weight = ?
    WHERE session_code = ? AND end_time IS NULL
  `);
  stmt.run(new Date().toISOString(), itemsProcessed, totalWeight, sessionCode);
  stmt.finalize();
}

function saveItem(itemData) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO items (session_code, material_type, weight, ai_confidence, ai_class_name, processed_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    itemData.sessionCode,
    itemData.material,
    itemData.weight,
    itemData.aiConfidence || null,
    itemData.className || null,
    new Date().toISOString()
  );
  stmt.finalize();
}

function saveRejection(rejectionData) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO rejections (session_code, reason, ai_confidence, ai_class_name, rejected_time)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    rejectionData.sessionCode || null,
    rejectionData.reason,
    rejectionData.aiConfidence || null,
    rejectionData.className || null,
    new Date().toISOString()
  );
  stmt.finalize();
}

function saveErrorToDatabase(errorData) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO errors (error_code, severity, category, message, details, error_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    errorData.code,
    errorData.severity,
    errorData.category,
    errorData.message,
    JSON.stringify(errorData.details),
    errorData.timestamp
  );
  stmt.finalize();
}

// Sync pending data to backend
async function syncPendingData() {
  if (!db) return;
  recordActivity('syncPendingData');
  
  try {
    // Sync sessions
    db.all('SELECT * FROM sessions WHERE synced = 0 LIMIT 50', async (err, sessions) => {
      if (err) return;
      for (const session of sessions) {
        try {
          await axios.post(`${CONFIG.backend.url}/api/sessions`, session, { timeout: 10000 });
          db.run('UPDATE sessions SET synced = 1, synced_at = ? WHERE id = ?',
            [new Date().toISOString(), session.id]);
        } catch (error) {
          // Will retry next sync
        }
      }
    });
    
    // Sync items
    db.all('SELECT * FROM items WHERE synced = 0 LIMIT 100', async (err, items) => {
      if (err) return;
      for (const item of items) {
        try {
          await axios.post(`${CONFIG.backend.url}/api/items`, item, { timeout: 10000 });
          db.run('UPDATE items SET synced = 1, synced_at = ? WHERE id = ?',
            [new Date().toISOString(), item.id]);
        } catch (error) {
          // Will retry next sync
        }
      }
    });
  } catch (error) {
    logError('E303', { function: 'syncPendingData', error: error.message });
  }
}

// ============================================
// ERROR LOGGING SYSTEM
// ============================================
function logError(code, details = {}, shouldPublish = true) {
  if (!ERROR_CODES[code]) {
    console.error(`⚠️ Unknown error code: ${code}`);
    return;
  }
  
  const errorData = {
    code,
    severity: ERROR_CODES[code].severity,
    category: ERROR_CODES[code].category,
    message: ERROR_CODES[code].message,
    details,
    deviceId: CONFIG.device.id,
    sessionCode: state.sessionCode || null,
    timestamp: new Date().toISOString()
  };
  
  state.health.errorCount++;
  
  const severityIcons = {
    INFO: '💡',
    WARNING: '⚠️',
    ERROR: '❌',
    CRITICAL: '🚨'
  };
  
  console.error(
    `${severityIcons[errorData.severity]} [${errorData.code}] ${errorData.message}`,
    Object.keys(details).length ? `| ${JSON.stringify(details)}` : ''
  );
  
  // Save to database
  saveErrorToDatabase(errorData);
  
  // Publish to MQTT
  if (shouldPublish && mqttClient && mqttClient.connected) {
    mqttClient.publish(CONFIG.mqtt.topics.errors, JSON.stringify(errorData), { qos: 1 });
  }
  
  return errorData;
}

// ============================================
// WATCHDOG SYSTEM
// ============================================
let lastActivityTimestamp = Date.now();
let watchdogTimer = null;
let watchdogAlerted = false;

function recordActivity(operation) {
  lastActivityTimestamp = Date.now();
  watchdogAlerted = false;
}

function startWatchdog() {
  if (!CONFIG.watchdog.enabled) return;
  
  console.log('🐕 Watchdog started\n');
  
  watchdogTimer = setInterval(() => {
    const timeSinceActivity = Date.now() - lastActivityTimestamp;
    
    // Warning level
    if (timeSinceActivity > CONFIG.watchdog.activityTimeout && !watchdogAlerted) {
      logError('E501', {
        timeSinceActivity: Math.round(timeSinceActivity / 1000),
        level: 'WARNING'
      });
      watchdogAlerted = true;
      
      mqttClient.publish(CONFIG.mqtt.topics.watchdog, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'warning',
        timeSinceActivity: timeSinceActivity,
        timestamp: new Date().toISOString()
      }), { qos: 1 });
    }
    
    // Critical level - restart
    if (timeSinceActivity > CONFIG.watchdog.criticalTimeout) {
      logError('E501', {
        timeSinceActivity: Math.round(timeSinceActivity / 1000),
        level: 'CRITICAL',
        action: 'restart'
      });
      
      console.error('🚨 WATCHDOG: System frozen - restarting!\n');
      
      mqttClient.publish(CONFIG.mqtt.topics.watchdog, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'critical',
        action: 'restart',
        timestamp: new Date().toISOString()
      }), { qos: 1 });
      
      setTimeout(() => process.exit(1), 2000);
    }
  }, CONFIG.watchdog.checkInterval);
}

// ============================================
// HEALTH MONITORING
// ============================================
function updateSystemVitals() {
  // CPU usage
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (let type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  state.health.systemVitals.cpuUsage = Math.round(100 - (100 * totalIdle / totalTick));
  
  // Memory usage
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  state.health.systemVitals.memoryUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
  
  state.health.lastHeartbeat = Date.now();
  state.health.uptime = Math.round(process.uptime());
}

// Heartbeat - every 5 seconds
setInterval(() => {
  updateSystemVitals();
  
  if (state.health.systemVitals.cpuUsage > 90) {
    logError('E502', { cpuUsage: state.health.systemVitals.cpuUsage });
  }
  
  if (state.health.systemVitals.memoryUsage > 90) {
    logError('E502', { memoryUsage: state.health.systemVitals.memoryUsage });
  }
}, CONFIG.health.heartbeatInterval);

// Publish health - every 30 seconds
setInterval(() => {
  if (!mqttClient || !mqttClient.connected) return;
  
  const healthStatus = {
    deviceId: CONFIG.device.id,
    timestamp: new Date().toISOString(),
    uptime: state.health.uptime,
    status: state.isReady ? 'ready' : 'busy',
    vitals: state.health.systemVitals,
    session: {
      active: state.autoCycleEnabled,
      itemsProcessed: state.itemsProcessed,
      totalCycles: state.health.totalCycles
    },
    errors: {
      count: state.health.errorCount
    }
  };
  
  mqttClient.publish(CONFIG.mqtt.topics.health, JSON.stringify(healthStatus), { qos: 1 });
}, CONFIG.health.publishInterval);

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = threshold * 0.3;
    
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      console.log(`✅ ${materialType} detected via keyword (${confidencePercent}%)`);
      return materialType;
    }
    
    console.log(`⚠️ ${materialType} low confidence (${confidencePercent}%)`);
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    console.log(`✅ ${materialType} detected (${confidencePercent}%)`);
  }
  
  return materialType;
}

// ============================================
// HARDWARE CONTROL
// ============================================
async function executeCommand(action, params = {}) {
  recordActivity(`executeCommand:${action}`);
  
  const deviceType = 1;
  
  if (!state.moduleId && action !== 'getModuleId') {
    logError('E504', { action });
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
      logError('E001', { action, message: 'Unknown action' });
      throw new Error(`Unknown action: ${action}`);
  }
  
  console.log(`🔧 ${action}`);
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (action === 'takePhoto') await delay(1500);
    if (action === 'getWeight') await delay(2000);
    
  } catch (error) {
    logError('E001', { action, error: error.message });
    throw error;
  }
}

// ============================================
// COMPACTOR MANAGEMENT
// ============================================
async function startCompactor() {
  if (state.compactorRunning) {
    console.log('⏳ Waiting for compactor...');
    const startWait = Date.now();
    
    while (state.compactorRunning && (Date.now() - startWait) < CONFIG.timing.compactor + 5000) {
      await delay(500);
    }
    
    if (state.compactorRunning) {
      console.log('⚠️ Compactor timeout - forcing stop');
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      state.compactorRunning = false;
    }
  }
  
  console.log('🎯 Compactor starting (background)');
  
  state.compactorRunning = true;
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  state.compactorTimer = setTimeout(async () => {
    console.log('✅ Compactor finished');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
  
  console.log('⚡ Ready for next bottle!\n');
}

// ============================================
// REJECTION HANDLING
// ============================================
async function executeRejectionCycle() {
  recordActivity('executeRejectionCycle');
  
  console.log('\n========================================');
  console.log('❌ REJECTION - UNRECOGNIZED ITEM');
  console.log('========================================\n');

  try {
    console.log('🎯 Reversing to reject bin');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Item rejected\n');

    saveRejection({
      sessionCode: state.sessionCode,
      reason: 'LOW_CONFIDENCE',
      aiConfidence: state.aiResult?.matchRate,
      className: state.aiResult?.className
    });
    
    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    logError('E402', { function: 'executeRejectionCycle', error: error.message });
  }

  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;

  if (state.autoCycleEnabled) {
    console.log('🚪 Opening gate for next item');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
        console.log('📸 AUTO PHOTO\n');
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================
// SESSION TIMEOUT
// ============================================
async function handleSessionTimeout(reason) {
  recordActivity('handleSessionTimeout');
  
  console.log('\n========================================');
  console.log('⏱️  SESSION TIMEOUT');
  console.log(`Reason: ${reason}`);
  console.log(`Items: ${state.itemsProcessed}`);
  console.log('========================================\n');
  
  logError('E403', { reason, itemsProcessed: state.itemsProcessed });
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'timeout',
    event: 'session_timeout',
    reason: reason,
    itemsProcessed: state.itemsProcessed,
    timestamp: new Date().toISOString()
  }));
  
  await resetSystemForNextUser(false);
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) clearTimeout(state.sessionTimeoutTimer);
  
  state.lastActivityTime = Date.now();
  
  state.sessionTimeoutTimer = setTimeout(() => {
    handleSessionTimeout('inactivity');
  }, CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  
  if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
  
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
// SESSION MANAGEMENT
// ============================================
async function startSession(isMember, sessionData) {
  recordActivity('startSession');
  
  console.log('\n========================================');
  console.log(`🎬 ${isMember ? 'MEMBER' : 'GUEST'} SESSION START`);
  console.log('========================================');
  
  state.isReady = false;
  
  if (isMember) {
    console.log(`👤 User: ${sessionData.userName || sessionData.userId}`);
    console.log(`🔑 Code: ${sessionData.sessionCode}`);
    state.currentUserId = sessionData.userId;
    state.currentUserData = {
      name: sessionData.userName,
      email: sessionData.userEmail,
      sessionCode: sessionData.sessionCode
    };
    state.isMember = true;
    state.isGuestSession = false;
    state.sessionCode = sessionData.sessionCode;
  } else {
    console.log(`🎫 Guest: ${sessionData.sessionCode}`);
    state.currentUserId = null;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.isMember = false;
    state.isGuestSession = true;
  }
  
  console.log('========================================\n');
  
  state.autoCycleEnabled = true;
  state.itemsProcessed = 0;
  state.sessionStartTime = new Date();
  state.lastActivityTime = Date.now();
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  startSessionTimers();
  
  console.log('🔧 Resetting system');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  
  if (state.compactorRunning) {
    console.log('⏳ Waiting for compactor');
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    if (state.compactorTimer) {
      clearTimeout(state.compactorTimer);
      state.compactorTimer = null;
    }
    state.compactorRunning = false;
  }
  
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);
  console.log('✅ Reset complete\n');
  
  console.log('⚖️ Calibrating weight sensor');
  await executeCommand('calibrateWeight');
  await delay(1500);
  console.log('✅ Calibrated\n');
  
  console.log('🚪 Opening gate');
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate open\n');
  
  // Save session to database
  saveSessionStart({
    sessionCode: state.sessionCode,
    sessionId: state.sessionId,
    userId: state.currentUserId,
    userName: state.currentUserData?.name,
    isGuest: !isMember
  });
  
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  state.autoPhotoTimer = setTimeout(() => {
    console.log('📸 AUTO PHOTO\n');
    state.awaitingDetection = true;
    executeCommand('takePhoto');
  }, CONFIG.timing.autoPhotoDelay);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'session_active',
    event: 'session_started',
    sessionType: isMember ? 'member' : 'guest',
    timestamp: new Date().toISOString()
  }));
}

async function resetSystemForNextUser(forceStop = false) {
  recordActivity('resetSystemForNextUser');
  
  console.log('\n========================================');
  console.log('🔄 RESETTING FOR NEXT USER');
  console.log('========================================\n');
  
  if (state.cycleInProgress) {
    console.log('⚠️ Cycle in progress - retrying\n');
    setTimeout(() => resetSystemForNextUser(forceStop), 2000);
    return;
  }
  
  console.log('🛑 Stopping operations');
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  state.detectionRetries = 0;
  state.isReady = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    // Handle compactor
    if (state.compactorRunning) {
      if (forceStop) {
        console.log('🚨 Force stopping compactor');
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
      } else {
        console.log('⏳ Waiting for compactor to finish');
        const maxWait = CONFIG.timing.compactor + 2000;
        const startWait = Date.now();
        
        while (state.compactorRunning && (Date.now() - startWait) < maxWait) {
          await delay(1000);
        }
        
        if (state.compactorRunning) {
          console.log('⚠️ Compactor timeout - forcing stop');
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) {
            clearTimeout(state.compactorTimer);
            state.compactorTimer = null;
          }
          state.compactorRunning = false;
        }
      }
    }
    
    console.log('🚪 Closing gate');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    
    console.log('🛑 Stopping motors');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
  } catch (error) {
    logError('E001', { function: 'resetSystemForNextUser', error: error.message });
  }
  
  // Calculate total weight
  if (db && state.sessionCode) {
    db.get('SELECT SUM(weight) as total FROM items WHERE session_code = ?',
      [state.sessionCode],
      (err, row) => {
        const totalWeight = (row && row.total) || 0;
        saveSessionEnd(state.sessionCode, state.itemsProcessed, totalWeight);
      }
    );
  }
  
  // Clear state
  state.aiResult = null;
  state.weight = null;
  state.currentUserId = null;
  state.currentUserData = null;
  state.sessionId = null;
  state.sessionCode = null;
  state.calibrationAttempts = 0;
  state.autoCycleEnabled = false;
  state.cycleInProgress = false;
  state.isMember = false;
  state.isGuestSession = false;
  state.itemsProcessed = 0;
  state.sessionStartTime = null;
  state.lastActivityTime = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  clearSessionTimers();
  
  state.isReady = true;
  
  console.log('========================================');
  console.log('✅ READY FOR NEXT USER');
  console.log('========================================\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'reset_complete',
    isReady: true,
    timestamp: new Date().toISOString()
  }), { retain: false });
}

// ============================================
// AUTO CYCLE
// ============================================
async function executeAutoCycle() {
  recordActivity('executeAutoCycle');
  
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing data for cycle');
    state.cycleInProgress = false;
    return;
  }

  state.itemsProcessed++;
  state.health.totalCycles++;
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    sessionCode: state.sessionCode,
    isGuest: state.isGuestSession,
    itemNumber: state.itemsProcessed,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n========================================');
  console.log(`🤖 CYCLE #${state.itemsProcessed}`);
  console.log(`📦 ${cycleData.material} | ⚖️ ${cycleData.weight}g`);
  console.log('========================================\n');

  try {
    console.log('🎯 Belt → Stepper');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 1\n');

    console.log('🎯 Stepper Rotation');
    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);
    console.log('✅ Step 2\n');

    console.log('🎯 Reverse Belt');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    console.log('✅ Step 3\n');

    console.log('🎯 Reset Stepper');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    console.log('✅ Step 4\n');

    // Start compactor in parallel
    await startCompactor();

    // Save to database
    saveItem({
      sessionCode: state.sessionCode,
      material: state.aiResult.materialType,
      weight: state.weight.weight,
      aiConfidence: state.aiResult.matchRate,
      className: state.aiResult.className
    });
    
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    console.log('========================================');
    console.log(`✅ CYCLE #${state.itemsProcessed} COMPLETE`);
    console.log('========================================\n');
    
    resetInactivityTimer();

  } catch (error) {
    logError('E402', { function: 'executeAutoCycle', error: error.message });
  }

  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;

  if (state.autoCycleEnabled) {
    console.log('🚪 Opening gate');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    
    state.autoPhotoTimer = setTimeout(() => {
      if (!state.cycleInProgress && !state.awaitingDetection) {
        console.log('📸 AUTO PHOTO\n');
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================
// WEBSOCKET
// ============================================
function connectWebSocket() {
  console.log('🔌 Connecting WebSocket');
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    console.log('✅ WebSocket connected\n');
  });
  
  state.ws.on('message', async (data) => {
    recordActivity('websocket:message');
    
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        console.log(`📟 Module ID: ${state.moduleId}\n`);
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
        
        console.log(`🤖 AI: ${materialType} (${state.aiResult.matchRate}%)`);
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.awaitingDetection) {
          if (state.aiResult.materialType !== 'UNKNOWN') {
            console.log('✅ Material identified\n');
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            setTimeout(() => executeCommand('getWeight'), 500);
          } else {
            state.detectionRetries++;
            console.log(`⚠️ UNKNOWN (${state.detectionRetries}/${CONFIG.detection.maxRetries})\n`);
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              logError('E201', { attempt: state.detectionRetries });
              setTimeout(() => {
                console.log('📸 RETRY\n');
                executeCommand('takePhoto');
              }, CONFIG.detection.retryDelay);
            } else {
              logError('E203', { maxRetries: CONFIG.detection.maxRetries });
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
        
        console.log(`⚖️ Weight: ${state.weight.weight}g`);
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          console.log(`⚠️ Calibrating (${state.calibrationAttempts}/2)\n`);
          logError('E101', { attempt: state.calibrationAttempts });
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            setTimeout(() => executeCommand('getWeight'), 1000);
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.aiResult && !state.cycleInProgress) {
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            console.log(`\n⚠️ Weight too low: ${state.weight.weight}g\n`);
            
            state.aiResult = null;
            state.weight = null;
            state.awaitingDetection = false;
            state.detectionRetries = 0;
            
            if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
            
            state.autoPhotoTimer = setTimeout(() => {
              if (!state.cycleInProgress && !state.awaitingDetection) {
                console.log('📸 AUTO PHOTO\n');
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
      
      if (message.function === 'deviceStatus') {
        const code = parseInt(message.data) || -1;
        console.log(`📊 Device Status: ${code}`);
        
        if (code >= 0 && code <= 3) {
          const bins = ['PET', 'Metal', 'Right', 'Glass'];
          logError('E401', { bin: bins[code], code });
        }
        return;
      }
      
    } catch (error) {
      logError('E302', { function: 'websocket:message', error: error.message });
    }
  });
  
  state.ws.on('close', () => {
    logError('E302', { event: 'close' });
    console.log('⚠️ WebSocket closed - reconnecting\n');
    setTimeout(connectWebSocket, 5000);
  });
  
  state.ws.on('error', (error) => {
    logError('E302', { event: 'error', error: error.message });
  });
}

// ============================================
// MQTT
// ============================================
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
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  mqttClient.subscribe(CONFIG.mqtt.topics.screenState);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  
  setTimeout(() => requestModuleId(), 2000);
});

mqttClient.on('error', (error) => {
  logError('E301', { error: error.message });
});

mqttClient.on('message', async (topic, message) => {
  recordActivity(`mqtt:${topic}`);
  
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.qrScan) {
      console.log('\n📱 QR SCAN RECEIVED\n');
      
      if (!state.isReady || !state.moduleId || state.cycleInProgress) {
        console.log('❌ System not ready\n');
        return;
      }
      
      if (state.autoCycleEnabled) {
        state.autoCycleEnabled = false;
        state.awaitingDetection = false;
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        await delay(500);
      }
      
      await startSession(true, payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      console.log('\n🎫 GUEST START RECEIVED\n');
      
      if (!state.isReady || state.cycleInProgress || state.autoCycleEnabled) {
        console.log('❌ System not ready\n');
        return;
      }
      
      await startSession(false, payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.screenState) {
      console.log(`📺 Screen: ${payload.state}`);
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
        console.log('🚨 EMERGENCY STOP\n');
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
        state.isReady = false;
        return;
      }
      
      if (payload.action === 'forceReset') {
        console.log('🚨 FORCE RESET\n');
        state.cycleInProgress = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        console.log('🏁 SESSION END\n');
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'busy',
          event: 'status_response',
          isReady: state.isReady,
          cycleInProgress: state.cycleInProgress,
          compactorRunning: state.compactorRunning,
          itemsProcessed: state.itemsProcessed,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (payload.action === 'takePhoto' && state.moduleId) {
        console.log('📸 MANUAL PHOTO\n');
        state.awaitingDetection = true;
        await executeCommand('takePhoto');
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    logError('E301', { topic, error: error.message });
  }
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
    console.log('📟 Module ID requested');
  } catch (error) {
    logError('E504', { error: error.message });
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down');
  
  if (state.compactorRunning && state.compactorTimer) {
    clearTimeout(state.compactorTimer);
  }
  
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) state.ws.close();
  if (db) db.close();
  mqttClient.end();
  
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ============================================
// STARTUP
// ============================================
console.log('========================================');
console.log('🚀 RVM AGENT - PRODUCTION READY');
console.log('========================================');
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Health Monitoring');
console.log('✅ Error Code System');
console.log('✅ Watchdog Timer');
console.log('✅ Data Persistence (SQLite)');
console.log('✅ Parallel Compactor');
console.log('========================================');
console.log('⏳ Initializing...\n');

initDatabase()
  .then(() => {
    console.log('✅ All systems ready\n');
    
    // Start watchdog after 5 seconds
    setTimeout(() => {
      startWatchdog();
    }, 5000);
    
    // Start data sync (every 5 minutes)
    setInterval(syncPendingData, 300000);
    
    // Mark as ready after module ID received
    setTimeout(() => {
      if (state.moduleId) {
        state.isReady = true;
        console.log('🟢 SYSTEM READY\n');
        
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'ready',
          event: 'startup_ready',
          isReady: true,
          timestamp: new Date().toISOString()
        }));
      }
    }, 3000);
  })
  .catch(err => {
    console.error('❌ Initialization failed:', err);
    process.exit(1);
  });
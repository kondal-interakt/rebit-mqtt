// ==================================================
// agent.js - Multi-Bottle Recycling (Member & Guest)
// ==================================================
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

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
      screenState: 'rvm/RVM-3101/screen/state'
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
    autoPhotoDelay: 5000,
    inactivityTimeout: 45000 // 45 seconds idle ends session
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

  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  isGuestSession: false,

  bottleCount: 0,
  lastActivityTime: null,
  inactivityTimer: null,
  autoPhotoTimer: null
};

// ============================================
// UTILITIES
// ============================================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function refreshInactivityTimer() {
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  state.lastActivityTime = Date.now();
  state.inactivityTimer = setTimeout(async () => {
    console.log('⏳ Inactivity timeout — ending session\n');
    await resetSystemForNextUser();
  }, CONFIG.timing.inactivityTimeout);
}

function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  let materialType = 'UNKNOWN';
  let threshold = 1.0;

  if (className.includes('易拉罐') || className.includes('metal') || className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } else if (className.includes('pet') || className.includes('plastic') || className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
  }

  if (materialType !== 'UNKNOWN' && probability < threshold) return 'UNKNOWN';
  return materialType;
}

// ============================================
// HARDWARE CONTROL
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  if (!state.moduleId && action !== 'getModuleId') throw new Error('Module ID missing');

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
      apiPayload = { moduleId: state.moduleId, motorId: params.motorId, type: params.type, deviceType };
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  try {
    await axios.post(apiUrl, apiPayload, { timeout: CONFIG.local.timeout });
    if (['takePhoto', 'getWeight'].includes(action)) await delay(1500);
  } catch (e) {
    console.error(`❌ ${action} failed:`, e.message);
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startSession(isMember, sessionData) {
  console.log(`\n🎬 START ${isMember ? 'MEMBER' : 'GUEST'} SESSION`);
  state.isMember = isMember;
  state.isGuestSession = !isMember;
  state.sessionId = sessionData.sessionId || null;
  state.sessionCode = sessionData.sessionCode || null;
  state.currentUserId = isMember ? sessionData.userId : null;
  state.bottleCount = 0;

  state.autoCycleEnabled = true;
  console.log('🔧 Resetting system...');
  await executeCommand('customMotor', CONFIG.motors.belt.stop);
  await executeCommand('customMotor', CONFIG.motors.compactor.stop);
  await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
  await delay(2000);

  console.log('🚪 Opening gate...');
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('✅ Gate opened, ready for bottles\n');

  refreshInactivityTimer();
}

async function resetSystemForNextUser() {
  console.log('\n🔄 RESET SYSTEM FOR NEXT USER');
  try {
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
  } catch (e) {
    console.error('❌ Reset error:', e.message);
  }

  if (state.bottleCount > 0) {
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'session_summary',
      bottleCount: state.bottleCount,
      userId: state.currentUserId || null,
      isGuest: state.isGuestSession,
      timestamp: new Date().toISOString()
    }));
  }

  Object.assign(state, {
    aiResult: null, weight: null, currentUserId: null,
    sessionId: null, sessionCode: null,
    isMember: false, isGuestSession: false,
    autoCycleEnabled: false, cycleInProgress: false,
    bottleCount: 0
  });
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  console.log('✅ READY FOR NEXT USER\n');
}

// ============================================
// AUTO CYCLE PROCESSING (MULTI-BOTTLE)
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing AI or weight data');
    state.cycleInProgress = false;
    return;
  }

  console.log('\n🤖 AUTO CYCLE START');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    const pos = state.aiResult.materialType === 'METAL_CAN'
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position: pos });
    await delay(CONFIG.timing.stepperRotate);

    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);

    const cycleData = {
      deviceId: CONFIG.device.id,
      material: state.aiResult.materialType,
      weight: state.weight.weight,
      userId: state.currentUserId || null,
      sessionId: state.sessionId || null,
      isGuest: state.isGuestSession,
      timestamp: new Date().toISOString()
    };
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    console.log('✅ Cycle complete published\n');
  } catch (e) {
    console.error('❌ Cycle error:', e.message);
  }

  // 🔁 Prepare for next bottle
  state.bottleCount += 1;
  state.aiResult = null;
  state.weight = null;
  state.calibrationAttempts = 0;
  state.cycleInProgress = false;

  console.log(`🧴 Bottles this session: ${state.bottleCount}`);
  await executeCommand('openGate');
  await delay(CONFIG.timing.gateOperation);
  console.log('🚪 Gate reopened for next bottle\n');

  refreshInactivityTimer();
}

// ============================================
// WEBSOCKET CONNECTION
// ============================================
function connectWebSocket() {
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  state.ws.on('open', () => console.log('✅ WebSocket connected\n'));

  state.ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.function === '01') {
        state.moduleId = msg.moduleId;
        console.log(`📟 Module ID: ${state.moduleId}`);
        return;
      }

      if (msg.function === 'aiPhoto') {
        const ai = JSON.parse(msg.data);
        const material = determineMaterialType(ai);
        state.aiResult = {
          matchRate: Math.round((ai.probability || 0) * 100),
          materialType: material,
          className: ai.className,
          taskId: ai.taskId
        };
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        if (material !== 'UNKNOWN') setTimeout(() => executeCommand('getWeight'), 500);
        return;
      }

      if (msg.function === '06') {
        const w = parseFloat(msg.data) || 0;
        const coef = CONFIG.weight.coefficients[1];
        const finalWeight = Math.round((w * (coef / 1000)) * 10) / 10;
        state.weight = { weight: finalWeight, rawWeight: w, timestamp: new Date().toISOString() };
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));

        if (finalWeight > 1 && state.autoCycleEnabled && !state.cycleInProgress) {
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 1000);
        }
        return;
      }

      if (msg.function === 'deviceStatus') {
        const code = parseInt(msg.data) || -1;
        if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
          console.log('👤 Object detected');
          refreshInactivityTimer();
          setTimeout(() => executeCommand('takePhoto'), 1000);
        }
        return;
      }
    } catch (e) {
      console.error('❌ WS parse error:', e.message);
    }
  });

  state.ws.on('close', () => setTimeout(connectWebSocket, 5000));
  state.ws.on('error', e => console.error('❌ WS error:', e.message));
}

// ============================================
// MQTT CONNECTION
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected');
  const t = CONFIG.mqtt.topics;
  mqttClient.subscribe([t.commands, t.autoControl, t.qrScan, t.guestStart, t.screenState]);
  mqttClient.publish(t.status, JSON.stringify({ deviceId: CONFIG.device.id, status: 'online', timestamp: new Date().toISOString() }), { retain: true });
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
});

mqttClient.on('message', async (topic, msg) => {
  try {
    const payload = JSON.parse(msg.toString());
    const t = CONFIG.mqtt.topics;

    if (topic === t.qrScan) return await startSession(true, payload);
    if (topic === t.guestStart) return await startSession(false, payload);

    if (topic === t.autoControl) {
      state.autoCycleEnabled = payload.enabled === true;
      await executeCommand(state.autoCycleEnabled ? 'openGate' : 'closeGate');
      return;
    }

    if (topic === t.commands) {
      const action = payload.action;
      if (action === 'emergencyStop') return await resetSystemForNextUser();
      if (action === 'endSession') return await resetSystemForNextUser();
      if (action === 'takePhoto') return await executeCommand('takePhoto');
      if (state.moduleId) await executeCommand(action, payload.params);
    }
  } catch (e) {
    console.error('❌ MQTT message error:', e.message);
  }
});

// ============================================
// INIT
// ============================================
async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, { timeout: 5000 });
  } catch (e) {
    console.error('❌ Module ID fetch failed:', e.message);
  }
}

function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...');
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'offline', timestamp: new Date().toISOString()
  }), { retain: true });
  if (state.ws) state.ws.close();
  mqttClient.end();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

console.log('========================================');
console.log('🚀 RVM AGENT - MULTI-BOTTLE MODE');
console.log('✅ Member + Guest Support');
console.log('✅ Auto reopen after each cycle');
console.log('✅ Auto end after idle');
console.log('========================================');

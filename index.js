/**
 * agent-prod-full.js
 * Production-ready RVM agent (full-featured)
 *
 * - Mirrors original behavior (serial commands via local middleware, websocket parse)
 * - MQTT TLS for backend
 * - Local WebSocket server for kiosk UI (ws://localhost:3001)
 * - Publishes cycle/complete (existing) + qr/reset (new MQTT topic)
 * - Broadcasts resetReady on local WS to ensure UI resets reliably
 *
 * Usage: node agent-prod-full.js
 *
 * Dependencies: npm i mqtt axios ws
 */

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

/* ----------------------------- CONFIG ----------------------------- */
const CONFIG = {
  device: { id: 'RVM-3101' },

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
      qrScan: 'rvm/RVM-3101/qr/scanned',
      resetScanner: 'rvm/RVM-3101/qr/reset' // NEW topic to trigger UI reset if UI subscribes via MQTT WS
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
      moduleId: '0F', // use 0F per spec for stepper module
      positions: { home: '00', metalCan: '02', plasticBottle: '03' }
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
  },

  uiWs: {
    port: 3001 // local websocket server for kiosk UI (fast, no certs)
  },

  // a simple safety: if a cycle takes longer than this, mark as stuck and attempt cleanup
  cycleTimeoutMs: 120000 // 2 minutes
};

/* ----------------------------- STATE ----------------------------- */
const state = {
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null, // websocket to middleware
  sessionId: null,
  currentUserId: null,
  currentUserData: null,
  autoPhotoTimer: null,
  cycleWatchdogTimer: null,
  uiClients: new Set()
};

/* ----------------------------- UTIL ----------------------------- */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const generateSessionId = () => `${CONFIG.device.id}-${Date.now()}`;

function nowISO() { return (new Date()).toISOString(); }

function safeReadCA(cafile) {
  try {
    if (!cafile) return undefined;
    if (fs.existsSync(cafile)) return fs.readFileSync(cafile);
    // try relative to script
    const maybe = path.resolve(__dirname, cafile);
    if (fs.existsSync(maybe)) return fs.readFileSync(maybe);
  } catch (err) {
    console.warn('CA read error:', err.message);
  }
  return undefined;
}

/* ----------------------------- LOCAL UI WEBSOCKET SERVER ----------------------------- */
const httpServer = http.createServer();
const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(CONFIG.uiWs.port, () => {
  console.log(`🌐 UI WebSocket server listening on ws://localhost:${CONFIG.uiWs.port}`);
});

wss.on('connection', (ws) => {
  console.log('🖥️ UI connected via local WS');
  state.uiClients.add(ws);
  // send initial ready message
  ws.send(JSON.stringify({ type: 'ready', deviceId: CONFIG.device.id, ts: nowISO() }));

  ws.on('message', (msg) => {
    // allow simple pings or debug commands if needed
    try {
      const data = JSON.parse(msg.toString());
      if (data && data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: nowISO() }));
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    state.uiClients.delete(ws);
    console.log('🖥️ UI disconnected');
  });

  ws.on('error', (err) => {
    console.warn('UI WS error:', err.message);
  });
});

function broadcastUI(obj) {
  const payload = JSON.stringify(obj);
  for (const c of state.uiClients) {
    try { if (c.readyState === WebSocket.OPEN) c.send(payload); }
    catch (e) { /* ignore send errors */ }
  }
}

/* ----------------------------- MQTT (backend) ----------------------------- */
const mqttOptions = {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  rejectUnauthorized: false
};
const caBuf = safeReadCA(CONFIG.mqtt.caFile);
if (caBuf) mqttOptions.ca = caBuf;

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, mqttOptions);

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected to broker');
  // subscribe to required topics
  const subs = [
    CONFIG.mqtt.topics.commands,
    CONFIG.mqtt.topics.autoControl,
    CONFIG.mqtt.topics.qrScan
  ];
  mqttClient.subscribe(subs, (err) => {
    if (err) console.warn('MQTT subscribe error', err.message);
    else console.log('Subscribed to topics:', subs.join(', '));
  });

  // publish initial online/ready status
  publishStatus('online');
  publishReadyStatus(); // also send reset to UI on startup
});

mqttClient.on('reconnect', () => console.log('🔁 MQTT reconnecting...'));
mqttClient.on('error', (err) => console.error('❌ MQTT error:', err.message));

mqttClient.on('close', () => console.log('⚠️ MQTT connection closed'));

/* ----------------------------- PUBLISH HELPERS ----------------------------- */
function publishStatus(status) {
  try {
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status,
      autoCycleEnabled: state.autoCycleEnabled,
      timestamp: nowISO()
    }), { retain: true });
  } catch (err) {
    console.warn('publishStatus failed', err.message);
  }
}

function publishReadyStatus() {
  // publish status + resetScanner minimal payload
  publishStatus('ready');
  try {
    mqttClient.publish(CONFIG.mqtt.topics.resetScanner, JSON.stringify({
      deviceId: CONFIG.device.id,
      action: 'resetScanner',
      timestamp: nowISO()
    }));
  } catch (err) { console.warn('publishReadyStatus mqtt publish failed', err.message); }

  // broadcast over local WS for UI clients
  broadcastUI({ type: 'resetReady', deviceId: CONFIG.device.id, timestamp: nowISO() });
}

/* ----------------------------- EXECUTE COMMAND (local middleware) ----------------------------- */
async function httpPost(url, payload, timeout = CONFIG.local.timeout) {
  try {
    const res = await axios.post(url, payload, { timeout, headers: { 'Content-Type': 'application/json' } });
    return res.data;
  } catch (err) {
    throw new Error(err.message || 'HTTP error');
  }
}

async function executeCommand(action, params = {}) {
  if (!action) throw new Error('action required');
  // get moduleId for actions except getModuleId & stepper (uses stepper.moduleId)
  if (!state.moduleId && action !== 'getModuleId' && action !== 'stepperMotor') {
    throw new Error('Module ID not available');
  }

  let apiUrl = null;
  let payload = null;

  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      payload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType: 1 };
      break;

    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      payload = { moduleId: state.moduleId, motorId: '01', type: '00', deviceType: 1 };
      break;

    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      payload = { moduleId: state.moduleId, type: '00' };
      break;

    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      payload = { moduleId: state.moduleId, type: '00' };
      break;

    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      payload = {};
      break;

    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      payload = {
        moduleId: CONFIG.motors.stepper.moduleId,
        type: params.position,
        deviceType: 1
      };
      break;

    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      payload = {
        moduleId: state.moduleId,
        motorId: params.motorId,
        type: params.type,
        deviceType: 1
      };
      break;

    case 'getModuleId':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getModuleId`;
      payload = {};
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  // Logging
  console.log(`🔧 executeCommand -> ${action}`, payload);

  // Try 2 attempts for critical commands (tolerant)
  try {
    return await httpPost(apiUrl, payload, CONFIG.local.timeout);
  } catch (err) {
    console.warn(`executeCommand ${action} failed first attempt: ${err.message}`);
    // quick retry
    await delay(400);
    return await httpPost(apiUrl, payload, CONFIG.local.timeout);
  }
}

/* ----------------------------- MATERIAL DETECTION ----------------------------- */
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

/* ----------------------------- AUTO CYCLE ----------------------------- */
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    console.log('⚠️ Missing aiResult or weight - aborting executeAutoCycle');
    publishReadyStatus();
    return;
  }

  state.cycleInProgress = true;
  state.sessionId = generateSessionId();
  const cycleStart = Date.now();

  // set cycle watchdog
  if (state.cycleWatchdogTimer) clearTimeout(state.cycleWatchdogTimer);
  state.cycleWatchdogTimer = setTimeout(() => {
    console.error('⏰ Cycle watchdog triggered - attempting emergency cleanup');
    // attempt cleanup
    emergencyStop().catch(() => {});
    publishReadyStatus();
    state.cycleInProgress = false;
  }, CONFIG.cycleTimeoutMs);

  console.log('\n========================================');
  console.log('🚀 CYCLE START', state.sessionId);
  console.log(`👤 User: ${state.currentUserId}`);
  console.log(`📍 Material: ${state.aiResult.materialType}`);
  console.log(`📊 AI: ${state.aiResult.matchRate}%`);
  console.log(`⚖️ Weight: ${state.weight.weight}g`);
  console.log('========================================\n');

  try {
    // Cancel autoPhoto timer if any
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }

    // Step 1: Open Gate
    console.log('▶️ Opening gate...');
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);

    // Step 2: Belt to weight
    console.log('▶️ Belt -> weight...');
    await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
    await delay(CONFIG.timing.beltToWeight);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Step 3: Belt -> stepper
    console.log('▶️ Belt -> stepper...');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await delay(CONFIG.timing.positionSettle);

    // Step 4: Stepper dump
    console.log('▶️ Stepper dump...');
    const position = (state.aiResult.materialType === 'METAL_CAN')
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    await executeCommand('stepperMotor', { position });
    await delay(CONFIG.timing.stepperRotate);

    // Step 5: Compactor
    console.log('▶️ Compactor start...');
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    await delay(CONFIG.timing.compactor);
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);

    // Step 6: Belt return
    console.log('▶️ Belt return...');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Step 7: Reset stepper
    console.log('▶️ Reset stepper...');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

    // Step 8: Close gate
    console.log('▶️ Closing gate...');
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateOperation);

    // Cycle end
    const cycleEnd = Date.now();
    const cycleData = {
      sessionId: state.sessionId,
      deviceId: CONFIG.device.id,
      materialType: state.aiResult.materialType,
      weight: state.weight.weight,
      aiMatchRate: state.aiResult.matchRate,
      userId: state.currentUserId,
      timestamp: nowISO(),
      cycleDurationMs: cycleEnd - cycleStart,
      success: true
    };

    // Publish cycle complete to MQTT and also broadcast to UI
    try { mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData)); }
    catch (e) { console.warn('publish cycleComplete failed:', e.message); }

    broadcastUI({ type: 'cycleComplete', payload: cycleData });
    // Also publish reset signal
    publishReadyStatus();

    console.log('========================================');
    console.log('✅ CYCLE COMPLETE');
    console.log(`⏱️ Duration: ${Math.round((cycleEnd - cycleStart) / 1000)}s`);
    console.log('========================================\n');
  } catch (err) {
    console.error('❌ Cycle error:', err.message);
    // publish failed cycle
    const cycleEnd = Date.now();
    const cycleData = {
      sessionId: state.sessionId || generateSessionId(),
      deviceId: CONFIG.device.id,
      materialType: state.aiResult?.materialType || 'UNKNOWN',
      weight: state.weight?.weight || 0,
      aiMatchRate: state.aiResult?.matchRate || 0,
      userId: state.currentUserId,
      timestamp: nowISO(),
      cycleDurationMs: cycleEnd - (state.sessionId ? parseInt(state.sessionId.split('-').pop()) : 0),
      success: false,
      error: err.message
    };

    try { mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData)); }
    catch (e) { console.warn('publish cycleComplete (error) failed:', e.message); }

    broadcastUI({ type: 'cycleComplete', payload: cycleData });
    publishReadyStatus();
  } finally {
    // cleanup always
    state.cycleInProgress = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    state.sessionId = null;
    state.calibrationAttempts = 0;

    if (state.cycleWatchdogTimer) {
      clearTimeout(state.cycleWatchdogTimer);
      state.cycleWatchdogTimer = null;
    }
  }
}

/* ----------------------------- EMERGENCY STOP ----------------------------- */
async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP requested');
  try {
    // best-effort stop motors & close gate
    await executeCommand('customMotor', CONFIG.motors.belt.stop).catch(() => {});
    await executeCommand('customMotor', CONFIG.motors.compactor.stop).catch(() => {});
    await executeCommand('closeGate').catch(() => {});
  } catch (err) {
    console.warn('emergencyStop error', err.message);
  } finally {
    state.cycleInProgress = false;
    state.autoCycleEnabled = false;
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    publishReadyStatus();
  }
}

/* ----------------------------- LOCAL MIDDLEWARE WEBSOCKET ----------------------------- */
function connectMiddlewareWS() {
  try {
    console.log('🔌 Connecting to local middleware WS', CONFIG.local.wsUrl);
    state.ws = new WebSocket(CONFIG.local.wsUrl);

    state.ws.on('open', () => {
      console.log('✅ Connected to middleware WS');
      // ask for moduleId once
      setTimeout(() => requestModuleId(), 800);
    });

    state.ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);

        // function '01' -> moduleId
        if (msg.function === '01') {
          state.moduleId = msg.moduleId || msg.data || state.moduleId;
          console.log('✅ Module ID:', state.moduleId);
          return;
        }

        // aiPhoto result
        if (msg.function === 'aiPhoto') {
          let aiData = msg.data;
          if (typeof aiData === 'string') {
            try { aiData = JSON.parse(aiData); } catch (e) { /* ignore */ }
          }
          const probability = aiData?.probability || 0;
          state.aiResult = {
            matchRate: Math.round(probability * 100),
            materialType: determineMaterialType(aiData || {}),
            className: aiData?.className || '',
            taskId: aiData?.taskId,
            timestamp: nowISO()
          };

          console.log('🤖 AI result ->', state.aiResult);

          // publish ai result to backend mqtt
          try { mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult)); }
          catch (e) { console.warn('publish aiResult failed', e.message); }

          // if auto cycle enabled and aiResult is valid -> get weight
          if (state.autoCycleEnabled && state.aiResult.materialType !== 'UNKNOWN') {
            const threshold = CONFIG.detection[state.aiResult.materialType] || 1.0;
            if ((aiData.probability || 0) >= threshold) {
              try { await executeCommand('getWeight'); } catch (err) { console.warn('getWeight failed', err.message); }
            } else {
              console.log('⚠️ AI confidence below threshold, skipping weight');
            }
          }
          return;
        }

        // weight result
        if (msg.function === '06') {
          const weightValue = parseFloat(msg.data) || 0;
          const coefficient = CONFIG.weight.coefficients[1] || 988;
          const calibratedWeight = weightValue * (coefficient / 1000);
          state.weight = {
            weight: Math.round(calibratedWeight * 10) / 10,
            rawWeight: weightValue,
            coefficient,
            timestamp: nowISO()
          };

          console.log('⚖️ Weight ->', state.weight);

          try { mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight)); }
          catch (e) { console.warn('publish weightResult failed', e.message); }

          // calibration logic if 0 or negative
          if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
            state.calibrationAttempts++;
            console.log(`⚠️ Weight <= 0, calibrating (${state.calibrationAttempts}/2)`);
            setTimeout(async () => {
              await executeCommand('calibrateWeight').catch(e => console.warn('calibrateWeight failed', e.message));
              await delay(1000);
              await executeCommand('getWeight').catch(e => console.warn('getWeight after calibrate failed', e.message));
            }, 500);
            return;
          }

          if (state.weight.weight > 0) state.calibrationAttempts = 0;

          // start auto cycle when both aiResult and weight are present and valid
          if (state.autoCycleEnabled && state.aiResult && state.weight.weight > 1 && !state.cycleInProgress) {
            // start in background
            executeAutoCycle().catch(e => {
              console.error('executeAutoCycle uncaught:', e.message);
              state.cycleInProgress = false;
              publishReadyStatus();
            });
          }
          return;
        }

        // deviceStatus event
        if (msg.function === 'deviceStatus') {
          const code = parseInt(msg.data, 10) || -1;
          // code 4 => object detected
          if (code === 4 && state.autoCycleEnabled && !state.cycleInProgress) {
            console.log('👤 OBJECT DETECTED by middleware -> scheduling photo');
            if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
            state.autoPhotoTimer = setTimeout(async () => {
              try { await executeCommand('takePhoto'); } catch (err) { console.warn('takePhoto failed', err.message); }
            }, 1000);
          }
          return;
        }

      } catch (err) {
        console.warn('middleware WS message parse err', err.message);
      }
    });

    state.ws.on('close', (code, reason) => {
      console.warn('⚠️ Middleware WS closed. Reconnecting in 3s', code, reason?.toString?.());
      setTimeout(connectMiddlewareWS, 3000);
    });

    state.ws.on('error', (err) => {
      console.warn('❌ Middleware WS error:', err.message);
    });

  } catch (err) {
    console.error('connectMiddlewareWS failed:', err.message);
    setTimeout(connectMiddlewareWS, 3000);
  }
}

/* ----------------------------- MQTT INBOUND HANDLING ----------------------------- */
mqttClient.on('message', async (topic, messageBuffer) => {
  const payloadStr = messageBuffer.toString();
  let payload = null;
  try { payload = JSON.parse(payloadStr); } catch (e) { payload = payloadStr; }

  try {
    if (topic === CONFIG.mqtt.topics.qrScan) {
      // backend validated QR and forwarded to agent via MQTT
      if (state.cycleInProgress) {
        console.log('⚠️ Cycle already in progress — ignoring qrScan message');
        return;
      }

      console.log('🎫 qrScan received via MQTT:', payload);
      if (payload && payload.userId) {
        state.currentUserId = payload.userId;
        state.currentUserData = payload;
      }
      state.autoCycleEnabled = true;

      // reset devices to safe state
      try {
        await executeCommand('customMotor', CONFIG.motors.belt.stop).catch(() => {});
        await executeCommand('customMotor', CONFIG.motors.compactor.stop).catch(() => {});
        await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home }).catch(() => {});
        await delay(1500);
      } catch (err) {
        console.warn('Reset motor sequence warning', err.message);
      }

      // open gate
      try {
        await executeCommand('openGate');
        await delay(CONFIG.timing.gateOperation);
      } catch (err) {
        console.warn('openGate failed', err.message);
      }

      // schedule auto photo just in case middleware's deviceStatus doesn't trigger
      if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = setTimeout(() => {
        executeCommand('takePhoto').catch(err => console.warn('auto takePhoto failed', err.message));
      }, CONFIG.timing.autoPhotoDelay);
    }

    if (topic === CONFIG.mqtt.topics.autoControl) {
      state.autoCycleEnabled = !!payload.enabled;
      console.log('Auto control set ->', state.autoCycleEnabled);
      if (state.moduleId) {
        try {
          if (state.autoCycleEnabled) await executeCommand('openGate');
          else await executeCommand('closeGate');
        } catch (err) { console.warn('autoControl motor command failed', err.message); }
      }
    }

    if (topic === CONFIG.mqtt.topics.commands) {
      console.log('MQTT command received ->', payload);
      if (payload.action === 'emergencyStop') {
        await emergencyStop();
      } else if (payload.action === 'takePhoto') {
        if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
        await executeCommand('takePhoto').catch(e => console.warn('manual takePhoto failed', e.message));
      } else if (payload.action === 'setMaterial') {
        const valid = ['METAL_CAN', 'PLASTIC_BOTTLE', 'GLASS'];
        if (valid.includes(payload.materialType)) {
          state.aiResult = {
            matchRate: 100,
            materialType: payload.materialType,
            className: 'MANUAL',
            taskId: 'manual_' + Date.now(),
            timestamp: nowISO()
          };
          console.log('Manual material set by MQTT:', payload.materialType);
          if (state.autoCycleEnabled) {
            try { await executeCommand('getWeight'); } catch (err) { console.warn('manual getWeight failed', err.message); }
          }
        }
      } else {
        // unknown action - attempt to treat as low-level executeCommand
        if (payload.action && payload.params) {
          try { await executeCommand(payload.action, payload.params); } catch (err) { console.warn('exec command failed', err.message); }
        }
      }
    }

  } catch (err) {
    console.error('MQTT message handler error', err.message);
  }
});

/* ----------------------------- MODULE ID REQUEST ----------------------------- */
async function requestModuleId() {
  try {
    await executeCommand('getModuleId');
  } catch (err) {
    console.warn('requestModuleId failed', err.message);
  }
}

/* ----------------------------- GRACEFUL SHUTDOWN ----------------------------- */
async function gracefulShutdown() {
  console.log('\n⏹️ Graceful shutdown initiated');
  try { publishStatus('offline'); } catch (e) {}
  try { mqttClient.end(true); } catch (e) {}
  try { if (state.ws) state.ws.close(); } catch (e) {}
  try { wss.close(); httpServer.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

/* ----------------------------- STARTUP ----------------------------- */
console.log('========================================');
console.log('🚀 RVM AGENT - PRODUCTION (full)');
console.log('========================================');

connectMiddlewareWS();

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/expensetracker';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Helper: Get Local Network IPv4 Address for Multi-Device Access ----------
function getLocalIp() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('192.168.56.') && !net.address.startsWith('169.254.')) {
          return net.address;
        }
      }
    }
  } catch (e) { }
  return '127.0.0.1';
}

// ---------- Mongoose Schemas & Models with User ID ----------
const expenseSchema = new mongoose.Schema({
  id: { type: String, required: true },
  userId: { type: String, required: true, index: true, default: 'usr_default' },
  month: { type: String, required: true, index: true },
  date: { type: String, required: true },
  category: { type: String, required: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});
expenseSchema.index({ userId: 1, month: 1 });
expenseSchema.index({ userId: 1, id: 1 }, { unique: true });

const budgetSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true, default: 'usr_default' },
  month: { type: String, required: true, index: true },
  amount: { type: Number, required: true, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});
budgetSchema.index({ userId: 1, month: 1 }, { unique: true });

const udhariSchema = new mongoose.Schema({
  id: { type: String, required: true },
  userId: { type: String, required: true, index: true, default: 'usr_default' },
  type: { type: String, enum: ['lent', 'borrowed'], required: true },
  person: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: String, required: true },
  dueDate: { type: String, default: '' },
  notes: { type: String, default: '' },
  settled: { type: Boolean, default: false },
  settledDate: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
udhariSchema.index({ userId: 1, id: 1 }, { unique: true });

const Expense = mongoose.model('Expense', expenseSchema);
const Budget = mongoose.model('Budget', budgetSchema);
const Udhari = mongoose.model('Udhari', udhariSchema);

// ---------- Multi-Device Shared Account Architecture ----------
const PRIMARY_USER_ID = 'usr_sahil_primary';

// Helper: Detect legacy unassigned, default, or random device auto-generated IDs (e.g. usr_mtr...)
function isLegacyOrAutoId(str) {
  if (!str) return true;
  const s = String(str).trim().toLowerCase();
  if (s === PRIMARY_USER_ID || s === 'sahil') return false;
  // Old generated device IDs: usr_[timestamp]_[random] e.g. usr_mtrll8ye_5ynxny
  if (/^usr_[a-z0-9]{6,10}_[a-z0-9]{4,10}$/i.test(s)) return true;
  if (['default', 'usr_default', 'user', 'null', 'undefined', 'anonymous', ''].includes(s)) return true;
  return false;
}

// Helper: Clean & Normalize Username / User ID (All devices default to usr_sahil_primary)
function normalizeUsername(raw) {
  if (!raw) return PRIMARY_USER_ID;
  let str = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!str || str === 'sahil' || str === PRIMARY_USER_ID || isLegacyOrAutoId(str)) {
    return PRIMARY_USER_ID;
  }
  return str;
}

// User filter helper: ensure 'usr_sahil_primary', 'sahil', and legacy device IDs query the same primary dataset
function getUserFilter(userId) {
  if (!userId || userId === PRIMARY_USER_ID || userId === 'sahil' || isLegacyOrAutoId(userId)) {
    return { $in: [PRIMARY_USER_ID, 'sahil'] };
  }
  return userId;
}

// Helper: Extract User ID from Request (defaults to usr_sahil_primary across all devices)
function getUserId(req) {
  const headerId = req.headers['x-user-id'] || req.headers['x-username'];
  const queryId = req.query ? (req.query.userId || req.query.username) : null;
  const bodyId = req.body && typeof req.body === 'object' ? (req.body.userId || req.body.username) : null;
  const raw = headerId || queryId || bodyId || PRIMARY_USER_ID;
  return normalizeUsername(raw);
}

// Universal Migration: Safely consolidate all legacy & device records into usr_sahil_primary
async function migrateAllToSahilPrimary() {
  try {
    const rawExpUsers = await Expense.distinct('userId');
    const rawBudUsers = await Budget.distinct('userId');
    const rawUdhUsers = await Udhari.distinct('userId');
    const allUsers = new Set([...rawExpUsers, ...rawBudUsers, ...rawUdhUsers]);

    const legacyUsers = [];
    for (const u of allUsers) {
      if (u && u !== PRIMARY_USER_ID && (u === 'sahil' || isLegacyOrAutoId(u))) {
        legacyUsers.push(u);
      }
    }

    const unassignedCount = await Expense.countDocuments({
      $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }]
    });

    if (legacyUsers.length > 0 || unassignedCount > 0) {
      console.log(`[Multi-Device Sync] Consolidating legacy/device accounts into '${PRIMARY_USER_ID}'...`);

      for (const legUser of legacyUsers) {
        // 1. Expenses
        const exps = await Expense.find({ userId: legUser });
        for (const exp of exps) {
          const exists = await Expense.findOne({ userId: PRIMARY_USER_ID, id: exp.id });
          if (!exists) {
            await Expense.updateOne({ _id: exp._id }, { $set: { userId: PRIMARY_USER_ID } });
          } else {
            const newId = exp.id + '_' + Math.random().toString(36).slice(2, 6);
            await Expense.updateOne({ _id: exp._id }, { $set: { userId: PRIMARY_USER_ID, id: newId } });
          }
        }

        // 2. Budgets
        const buds = await Budget.find({ userId: legUser });
        for (const b of buds) {
          const exists = await Budget.findOne({ userId: PRIMARY_USER_ID, month: b.month });
          if (!exists) {
            await Budget.updateOne({ _id: b._id }, { $set: { userId: PRIMARY_USER_ID } });
          } else {
            await Budget.deleteOne({ _id: b._id });
          }
        }

        // 3. Udharis
        const udhs = await Udhari.find({ userId: legUser });
        for (const u of udhs) {
          const exists = await Udhari.findOne({ userId: PRIMARY_USER_ID, id: u.id });
          if (!exists) {
            await Udhari.updateOne({ _id: u._id }, { $set: { userId: PRIMARY_USER_ID } });
          } else {
            const newId = u.id + '_' + Math.random().toString(36).slice(2, 6);
            await Udhari.updateOne({ _id: u._id }, { $set: { userId: PRIMARY_USER_ID, id: newId } });
          }
        }
      }

      // Unassigned records
      if (unassignedCount > 0) {
        await Expense.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }] },
          { $set: { userId: PRIMARY_USER_ID } }
        );
        await Budget.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }] },
          { $set: { userId: PRIMARY_USER_ID } }
        );
        await Udhari.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }] },
          { $set: { userId: PRIMARY_USER_ID } }
        );
      }

      console.log(`[Multi-Device Sync] All data successfully consolidated into '${PRIMARY_USER_ID}'.`);
    }
  } catch (err) {
    console.warn('[Migration Warning]:', err.message);
  }
}

async function claimLegacyDataIfNeeded(userId) {
  await migrateAllToSahilPrimary();
}

// ---------- MongoDB Connection & Index Normalization ----------
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log(`Connected to MongoDB successfully: ${MONGODB_URI}`);

    // Automatically consolidate legacy & device records to usr_sahil_primary
    await migrateAllToSahilPrimary();

    try {
      // Drop legacy single unique index month_1 on budgets if it exists
      await mongoose.connection.collection('budgets').dropIndex('month_1');
      console.log('Normalized budget indices: dropped legacy month_1 index in favor of { userId: 1, month: 1 }');
    } catch (e) {
      // Index not found or already dropped
    }
    try {
      // Drop legacy single unique index id_1 on expenses if it exists
      await mongoose.connection.collection('expenses').dropIndex('id_1');
      console.log('Normalized expense indices: dropped legacy id_1 index in favor of { userId: 1, id: 1 }');
    } catch (e) {
      // Index not found or already dropped
    }
    try {
      // Drop legacy single unique index id_1 on udharis if it exists
      await mongoose.connection.collection('udharis').dropIndex('id_1');
      console.log('Normalized udhari indices: dropped legacy id_1 index in favor of { userId: 1, id: 1 }');
    } catch (e) {
      // Index not found or already dropped
    }
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
  });

// ---------- API Routes ----------

// 1. Health, Connection & User Status with Multi-Device Network URL
app.get('/api/status', async (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  const userId = getUserId(req);
  if (isConnected) {
    await claimLegacyDataIfNeeded(userId);
  }
  const localIp = getLocalIp();
  res.json({
    status: 'ok',
    connected: isConnected,
    userId: userId,
    defaultAccount: PRIMARY_USER_ID,
    database: isConnected ? mongoose.connection.name : null,
    networkIp: localIp,
    networkPort: PORT,
    networkUrl: `http://${localIp}:${PORT}`,
    uri: MONGODB_URI.replace(/\/\/.*@/, '//***@')
  });
});

// 1b. User Summary & Month Discovery (Finds all active months for this username across devices)
app.get('/api/user/summary', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);

    const expCount = await Expense.countDocuments({ userId: userFilter });
    const budCount = await Budget.countDocuments({ userId: userFilter });
    const udhariCount = await Udhari.countDocuments({ userId: userFilter });

    const distinctMonths = await Expense.distinct('month', { userId: userFilter });
    distinctMonths.sort().reverse();

    res.json({
      success: true,
      userId,
      totalExpenses: expCount,
      totalBudgets: budCount,
      totalUdharis: udhariCount,
      monthsWithData: distinctMonths,
      latestMonth: distinctMonths[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1c. Get All Data for User (Instant full restore when switching device / username)
app.get('/api/user/all-data', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);

    const expenses = await Expense.find({ userId: userFilter }).sort({ date: -1, createdAt: -1 });
    const budgets = await Budget.find({ userId: userFilter });
    const udharis = await Udhari.find({ userId: userFilter }).sort({ date: -1, createdAt: -1 });

    const monthlyExpenses = {};
    for (const e of expenses) {
      if (!monthlyExpenses[e.month]) monthlyExpenses[e.month] = [];
      monthlyExpenses[e.month].push(e);
    }

    const monthlyBudgets = {};
    for (const b of budgets) {
      monthlyBudgets[b.month] = b.amount;
    }

    res.json({
      success: true,
      userId,
      counts: {
        expenses: expenses.length,
        budgets: budgets.length,
        udhari: udharis.length
      },
      monthlyExpenses,
      monthlyBudgets,
      udhariRecords: udharis
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Expenses by Month & User
app.get('/api/expenses/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);
    const { month } = req.params;
    const expenses = await Expense.find({ userId: userFilter, month }).sort({ date: -1, createdAt: -1 });
    res.json({ expenses, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    const userFilter = getUserFilter(userId);
    const { month } = req.params;
    const incoming = Array.isArray(req.body) ? req.body : req.body.expenses || [];

    await Expense.deleteMany({ userId: userFilter, month });
    if (incoming.length > 0) {
      const docs = incoming.map(e => ({
        id: String(e.id),
        userId: userId,
        month: month,
        date: e.date,
        category: e.category,
        description: e.description,
        amount: Number(e.amount),
        createdAt: e.createdAt || new Date()
      }));
      await Expense.insertMany(docs);
    }
    const updated = await Expense.find({ userId: userFilter, month }).sort({ date: -1 });
    res.json({ success: true, expenses: updated, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Budget by Month & User
app.get('/api/budget/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);
    const { month } = req.params;
    const doc = await Budget.findOne({ userId: userFilter, month });
    res.json({ budget: doc ? doc.amount : 0, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/budget/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    const userFilter = getUserFilter(userId);
    const { month } = req.params;
    const amount = Number(req.body.amount || 0);
    const doc = await Budget.findOneAndUpdate(
      { userId: userFilter, month },
      { userId, month, amount, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, budget: doc.amount, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Trend (Historical 6 months aggregation for User)
app.get('/api/trend/:currentMonth', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);
    const [year, monthNum] = req.params.currentMonth.split('-').map(Number);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, monthNum - 1 - i, 1);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push({ key: k, date: d });
    }

    const monthKeys = months.map(m => m.key);
    const agg = await Expense.aggregate([
      { $match: { userId: userFilter, month: { $in: monthKeys } } },
      { $group: { _id: '$month', total: { $sum: '$amount' } } }
    ]);

    const totalsMap = {};
    agg.forEach(item => { totalsMap[item._id] = item.total; });

    const results = months.map(m => ({
      key: m.key,
      monthLabel: m.date.toLocaleDateString('en-IN', { month: 'short' }),
      total: totalsMap[m.key] || 0
    }));

    res.json({ trend: results, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Udhari Records by User
app.get('/api/udhari', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);
    const records = await Udhari.find({ userId: userFilter }).sort({ date: -1, createdAt: -1 });
    res.json({ records, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/udhari', async (req, res) => {
  try {
    const userId = getUserId(req);
    const userFilter = getUserFilter(userId);
    const incoming = Array.isArray(req.body) ? req.body : req.body.records || [];
    await Udhari.deleteMany({ userId: userFilter });
    if (incoming.length > 0) {
      const docs = incoming.map(r => ({
        id: String(r.id),
        userId: userId,
        type: r.type,
        person: r.person,
        amount: Number(r.amount),
        date: r.date,
        dueDate: r.dueDate || '',
        notes: r.notes || '',
        settled: Boolean(r.settled),
        settledDate: r.settledDate || null,
        createdAt: r.createdAt || new Date()
      }));
      await Udhari.insertMany(docs);
    }
    const updated = await Udhari.find({ userId: userFilter }).sort({ date: -1 });
    res.json({ success: true, records: updated, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Bulk Auto-Migration / Sync Endpoint with User ID
app.post('/api/sync', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const userFilter = getUserFilter(userId);
    const { monthlyExpenses = {}, monthlyBudgets = {}, udhariRecords = [] } = req.body;
    let syncedExpenses = 0;
    let syncedBudgets = 0;
    let syncedUdhari = 0;

    // 1. Sync Expenses
    for (const [month, expList] of Object.entries(monthlyExpenses)) {
      if (Array.isArray(expList)) {
        for (const e of expList) {
          if (e && e.id) {
            await Expense.findOneAndUpdate(
              { userId: userFilter, id: String(e.id) },
              {
                id: String(e.id),
                userId: userId,
                month: month,
                date: e.date,
                category: e.category,
                description: e.description,
                amount: Number(e.amount)
              },
              { upsert: true }
            );
            syncedExpenses++;
          }
        }
      }
    }

    // 2. Sync Budgets
    for (const [month, amt] of Object.entries(monthlyBudgets)) {
      const num = Number(amt);
      if (!isNaN(num) && num > 0) {
        await Budget.findOneAndUpdate(
          { userId: userFilter, month },
          { userId: userId, month, amount: num, updatedAt: new Date() },
          { upsert: true }
        );
        syncedBudgets++;
      }
    }

    // 3. Sync Udhari
    if (Array.isArray(udhariRecords)) {
      for (const r of udhariRecords) {
        if (r && r.id) {
          await Udhari.findOneAndUpdate(
            { userId: userFilter, id: String(r.id) },
            {
              id: String(r.id),
              userId: userId,
              type: r.type,
              person: r.person,
              amount: Number(r.amount),
              date: r.date,
              dueDate: r.dueDate || '',
              notes: r.notes || '',
              settled: Boolean(r.settled),
              settledDate: r.settledDate || null
            },
            { upsert: true }
          );
          syncedUdhari++;
        }
      }
    }

    console.log(`[User: ${userId}] Sync completed: ${syncedExpenses} expenses, ${syncedBudgets} budgets, ${syncedUdhari} udhari records.`);
    res.json({
      success: true,
      userId,
      message: `All local data successfully synced to MongoDB for user ${userId}!`,
      counts: {
        expenses: syncedExpenses,
        budgets: syncedBudgets,
        udhari: syncedUdhari
      }
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Serve Static Frontend Files ----------
app.use(express.static(path.join(__dirname)));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon-32x32.png'));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Start Server ----------
const localIp = getLocalIp();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ExpenseTrackr server running:`);
  console.log(`  - Local:   http://localhost:${PORT}`);
  console.log(`  - Network: http://${localIp}:${PORT} (Open this on your phone/tablet/other laptop)`);
  console.log(`Connected database: ${MONGODB_URI}`);
});

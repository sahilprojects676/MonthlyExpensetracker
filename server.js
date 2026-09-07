require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/expensetracker';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Mongoose Schemas & Models with User ID ----------
const expenseSchema = new mongoose.Schema({
  id: { type: String, required: true, index: true },
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
  id: { type: String, required: true, index: true },
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

// ---------- Helper: Extract User ID from Request ----------
function getUserId(req) {
  const headerId = req.headers['x-user-id'];
  const queryId = req.query ? req.query.userId : null;
  const bodyId = req.body && typeof req.body === 'object' ? req.body.userId : null;
  const raw = headerId || queryId || bodyId || 'usr_default';
  return String(raw).trim();
}

// ---------- Zero Data Loss: Claim Legacy Unassigned Records ----------
async function claimLegacyDataIfNeeded(userId) {
  if (!userId || userId === 'usr_default') return;
  try {
    const unassignedExpenses = await Expense.countDocuments({
      $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }, { userId: 'usr_default' }]
    });

    if (unassignedExpenses > 0) {
      const userExpenses = await Expense.countDocuments({ userId });
      if (userExpenses === 0) {
        console.log(`[Migration] Attributing ${unassignedExpenses} legacy expenses to primary user: ${userId}`);
        await Expense.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }, { userId: 'usr_default' }] },
          { $set: { userId } }
        );
        await Budget.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }, { userId: 'usr_default' }] },
          { $set: { userId } }
        );
        await Udhari.updateMany(
          { $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }, { userId: 'usr_default' }] },
          { $set: { userId } }
        );
        console.log(`[Migration] Completed successfully for user: ${userId}`);
      }
    }
  } catch (err) {
    console.warn('[Migration Warning]:', err.message);
  }
}

// ---------- MongoDB Connection & Index Normalization ----------
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log(`Connected to MongoDB successfully: ${MONGODB_URI}`);
    try {
      // Drop legacy single unique index month_1 on budgets if it exists
      await mongoose.connection.collection('budgets').dropIndex('month_1');
      console.log('Normalized budget indices: dropped legacy month_1 index in favor of { userId: 1, month: 1 }');
    } catch (e) {
      // Index not found or already dropped
    }
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
  });

// ---------- API Routes ----------

// 1. Health, Connection & User Status
app.get('/api/status', async (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  const userId = getUserId(req);
  if (isConnected) {
    await claimLegacyDataIfNeeded(userId);
  }
  res.json({
    status: 'ok',
    connected: isConnected,
    userId: userId,
    database: isConnected ? mongoose.connection.name : null,
    uri: MONGODB_URI.replace(/\/\/.*@/, '//***@')
  });
});

// 2. Expenses by Month & User
app.get('/api/expenses/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    await claimLegacyDataIfNeeded(userId);
    const { month } = req.params;
    const expenses = await Expense.find({ userId, month }).sort({ date: -1, createdAt: -1 });
    res.json({ expenses, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { month } = req.params;
    const incoming = Array.isArray(req.body) ? req.body : req.body.expenses || [];

    await Expense.deleteMany({ userId, month });
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
    const updated = await Expense.find({ userId, month }).sort({ date: -1 });
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
    const { month } = req.params;
    const doc = await Budget.findOne({ userId, month });
    res.json({ budget: doc ? doc.amount : 0, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/budget/:month', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { month } = req.params;
    const amount = Number(req.body.amount || 0);
    const doc = await Budget.findOneAndUpdate(
      { userId, month },
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
    const [year, monthNum] = req.params.currentMonth.split('-').map(Number);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, monthNum - 1 - i, 1);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push({ key: k, date: d });
    }

    const monthKeys = months.map(m => m.key);
    const agg = await Expense.aggregate([
      { $match: { userId, month: { $in: monthKeys } } },
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
    const records = await Udhari.find({ userId }).sort({ date: -1, createdAt: -1 });
    res.json({ records, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/udhari', async (req, res) => {
  try {
    const userId = getUserId(req);
    const incoming = Array.isArray(req.body) ? req.body : req.body.records || [];
    await Udhari.deleteMany({ userId });
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
    const updated = await Udhari.find({ userId }).sort({ date: -1 });
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
              { userId, id: String(e.id) },
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
          { userId, month },
          { userId, month, amount: num, updatedAt: new Date() },
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
            { userId, id: String(r.id) },
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
app.listen(PORT, () => {
  console.log(`ExpenseTrackr server running on http://localhost:${PORT}`);
  console.log(`Connected database: ${MONGODB_URI}`);
});

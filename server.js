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

// ---------- Mongoose Schemas & Models ----------
const expenseSchema = new mongoose.Schema({
  id: { type: String, required: true },
  month: { type: String, required: true, index: true },
  date: { type: String, required: true },
  category: { type: String, required: true },
  description: { type: String, required: true },
  amount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});
expenseSchema.index({ id: 1 });

const budgetSchema = new mongoose.Schema({
  month: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, required: true, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

const udhariSchema = new mongoose.Schema({
  id: { type: String, required: true, index: true },
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

const Expense = mongoose.model('Expense', expenseSchema);
const Budget = mongoose.model('Budget', budgetSchema);
const Udhari = mongoose.model('Udhari', udhariSchema);

// ---------- MongoDB Connection & Index Normalization ----------
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log(`Connected to MongoDB successfully: ${MONGODB_URI}`);

    // Drop legacy compound user indexes if present so documents save cleanly without accounts
    try {
      await mongoose.connection.collection('budgets').dropIndex('userId_1_month_1');
    } catch (e) { }
    try {
      await mongoose.connection.collection('expenses').dropIndex('userId_1_id_1');
    } catch (e) { }
    try {
      await mongoose.connection.collection('expenses').dropIndex('userId_1_month_1');
    } catch (e) { }
    try {
      await mongoose.connection.collection('udharis').dropIndex('userId_1_id_1');
    } catch (e) { }
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
  });

// ---------- API Routes ----------

// 1. Health & Connection Status
app.get('/api/status', (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.json({
    status: 'ok',
    connected: isConnected,
    database: isConnected ? mongoose.connection.name : null,
    uri: MONGODB_URI.replace(/\/\/.*@/, '//***@')
  });
});

// 2. Expenses by Month
app.get('/api/expenses/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const expenses = await Expense.find({ month }).sort({ date: -1, createdAt: -1 });
    res.json({ expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const incoming = Array.isArray(req.body) ? req.body : req.body.expenses || [];

    await Expense.deleteMany({ month });
    if (incoming.length > 0) {
      const docs = incoming.map(e => ({
        id: String(e.id),
        month: month,
        date: e.date,
        category: e.category,
        description: e.description,
        amount: Number(e.amount),
        createdAt: e.createdAt || new Date()
      }));
      await Expense.insertMany(docs);
    }
    const updated = await Expense.find({ month }).sort({ date: -1 });
    res.json({ success: true, expenses: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Budget by Month
app.get('/api/budget/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const doc = await Budget.findOne({ month });
    res.json({ budget: doc ? doc.amount : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/budget/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const amount = Number(req.body.amount || 0);
    const doc = await Budget.findOneAndUpdate(
      { month },
      { month, amount, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, budget: doc.amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Trend (Historical 6 months aggregation)
app.get('/api/trend/:currentMonth', async (req, res) => {
  try {
    const [year, monthNum] = req.params.currentMonth.split('-').map(Number);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, monthNum - 1 - i, 1);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push({ key: k, date: d });
    }

    const monthKeys = months.map(m => m.key);
    const agg = await Expense.aggregate([
      { $match: { month: { $in: monthKeys } } },
      { $group: { _id: '$month', total: { $sum: '$amount' } } }
    ]);

    const totalsMap = {};
    agg.forEach(item => { totalsMap[item._id] = item.total; });

    const results = months.map(m => ({
      key: m.key,
      monthLabel: m.date.toLocaleDateString('en-IN', { month: 'short' }),
      total: totalsMap[m.key] || 0
    }));

    res.json({ trend: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Udhari Records
app.get('/api/udhari', async (req, res) => {
  try {
    const records = await Udhari.find().sort({ date: -1, createdAt: -1 });
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/udhari', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body) ? req.body : req.body.records || [];
    await Udhari.deleteMany({});
    if (incoming.length > 0) {
      const docs = incoming.map(r => ({
        id: String(r.id),
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
    const updated = await Udhari.find().sort({ date: -1 });
    res.json({ success: true, records: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Bulk Save / Sync Endpoint (for imported data and migrations)
app.post('/api/sync', async (req, res) => {
  try {
    const { monthlyExpenses = {}, monthlyBudgets = {}, udhariRecords = [] } = req.body;
    let savedExpenses = 0;
    let savedBudgets = 0;
    let savedUdhari = 0;

    // 1. Save Expenses
    for (const [month, expList] of Object.entries(monthlyExpenses)) {
      if (Array.isArray(expList)) {
        for (const e of expList) {
          if (e && e.id) {
            await Expense.findOneAndUpdate(
              { id: String(e.id) },
              {
                id: String(e.id),
                month: month,
                date: e.date,
                category: e.category,
                description: e.description,
                amount: Number(e.amount)
              },
              { upsert: true }
            );
            savedExpenses++;
          }
        }
      }
    }

    // 2. Save Budgets
    for (const [month, amt] of Object.entries(monthlyBudgets)) {
      const num = Number(amt);
      if (!isNaN(num) && num > 0) {
        await Budget.findOneAndUpdate(
          { month },
          { month, amount: num, updatedAt: new Date() },
          { upsert: true }
        );
        savedBudgets++;
      }
    }

    // 3. Save Udhari
    if (Array.isArray(udhariRecords)) {
      for (const r of udhariRecords) {
        if (r && r.id) {
          await Udhari.findOneAndUpdate(
            { id: String(r.id) },
            {
              id: String(r.id),
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
          savedUdhari++;
        }
      }
    }

    console.log(`Saved to MongoDB: ${savedExpenses} expenses, ${savedBudgets} budgets, ${savedUdhari} udhari records.`);
    res.json({
      success: true,
      message: 'All data successfully saved to MongoDB!',
      counts: {
        expenses: savedExpenses,
        budgets: savedBudgets,
        udhari: savedUdhari
      }
    });
  } catch (err) {
    console.error('Save error:', err);
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ExpenseTrackr server running on port ${PORT}`);
  console.log(`Connected database: ${MONGODB_URI}`);
});

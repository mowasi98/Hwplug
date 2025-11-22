require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE CONNECTION
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// SCHEMAS
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  credits: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customerEmail: { type: String, required: true },
  items: { type: Array, required: true },
  total: { type: Number, required: true },
  homeworkEmail: { type: String },
  homeworkPassword: { type: String },
  stripeSessionId: { type: String },
  status: { type: String, default: 'pending' },
  discountCode: { type: String, default: null },
  discountAmount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const discountSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  type: { type: String, enum: ['percentage', 'fixed'], required: true },
  value: { type: Number, required: true },
  minPurchase: { type: Number, default: 0 },
  maxUses: { type: Number, default: null },
  usedCount: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const referralSchema = new mongoose.Schema({
  referrerCode: { type: String, required: true },
  referredEmail: { type: String, required: true },
  reward: { type: Number, default: 0 },
  status: { type: String, default: 'completed' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Order = mongoose.model('Order', orderSchema);
const Discount = mongoose.model('Discount', discountSchema);
const Referral = mongoose.model('Referral', referralSchema);

// EMAIL SETUP
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// MIDDLEWARE
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const authenticateAdmin = (req, res, next) => {
  const { email, password } = req.headers;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ error: 'Invalid admin credentials' });
  }
};

// HELPERS
function generateReferralCode() {
  return 'HW' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: to,
      subject: subject,
      html: html
    });
    console.log(`✅ Email sent to ${to}`);
  } catch (error) {
    console.error('❌ Email failed:', error);
  }
}

// ROUTES

// Health check
app.get('/', (req, res) => {
  res.send('🚀 hwplug v2 Backend Running!');
});

// Register
app.post('/api/auth/register', [
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('name').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password, name, referralCode } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let newReferralCode = generateReferralCode();
    while (await User.findOne({ referralCode: newReferralCode })) {
      newReferralCode = generateReferralCode();
    }

    const user = new User({
      email,
      password: hashedPassword,
      name,
      referralCode: newReferralCode,
      referredBy: referralCode || null,
      credits: referralCode ? 1 : 0
    });

    await user.save();

    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) {
        referrer.credits += 2;
        await referrer.save();
        await new Referral({
          referrerCode: referralCode,
          referredEmail: email,
          reward: 2
        }).save();
      }
    }

    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    await sendEmail(email, 'Welcome to hwplug! 🎉', `
      <h2>Welcome, ${name}!</h2>
      <p>Your referral code: <strong>${newReferralCode}</strong></p>
      <p>Share it to earn £2 per referral!</p>
      ${referralCode ? '<p>🎁 You got £1 credit for using a referral code!</p>' : ''}
    `);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        referralCode: user.referralCode,
        credits: user.credits
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        referralCode: user.referralCode,
        credits: user.credits
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get user orders
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Validate discount
app.post('/api/discount/validate', async (req, res) => {
  try {
    const { code, total } = req.body;
    const discount = await Discount.findOne({ code: code.toUpperCase(), active: true });
    
    if (!discount) {
      return res.status(404).json({ error: 'Invalid discount code' });
    }

    if (discount.expiresAt && new Date() > discount.expiresAt) {
      return res.status(400).json({ error: 'Discount code expired' });
    }

    if (discount.maxUses && discount.usedCount >= discount.maxUses) {
      return res.status(400).json({ error: 'Discount code limit reached' });
    }

    if (total < discount.minPurchase) {
      return res.status(400).json({ error: `Minimum purchase of £${discount.minPurchase} required` });
    }

    let discountAmount = 0;
    if (discount.type === 'percentage') {
      discountAmount = (total * discount.value) / 100;
    } else {
      discountAmount = discount.value;
    }

    res.json({
      success: true,
      discount: {
        code: discount.code,
        type: discount.type,
        value: discount.value,
        amount: discountAmount
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to validate discount' });
  }
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, homeworkEmail, homeworkPassword, discountCode, userId } = req.body;

    let total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let discountAmount = 0;
    let creditsUsed = 0;

    // Apply credits
    if (userId) {
      const user = await User.findById(userId);
      if (user && user.credits > 0) {
        creditsUsed = Math.min(user.credits, total);
        total -= creditsUsed;
        user.credits -= creditsUsed;
        await user.save();
      }
    }

    // Apply discount
    if (discountCode) {
      const discount = await Discount.findOne({ code: discountCode.toUpperCase(), active: true });
      if (discount) {
        if (discount.type === 'percentage') {
          discountAmount = (total * discount.value) / 100;
        } else {
          discountAmount = discount.value;
        }
        total -= discountAmount;
        discount.usedCount += 1;
        await discount.save();
      }
    }

    total = Math.max(total, 0.50);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `hwplug Order - ${items.map(i => i.name).join(', ')}`
          },
          unit_amount: Math.round(total * 100)
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || process.env.FRONTEND_URL}/cancel.html`,
      customer_email: customerEmail,
      metadata: {
        homeworkEmail,
        homeworkPassword,
        items: JSON.stringify(items),
        userId: userId || '',
        creditsUsed: creditsUsed.toString()
      }
    });

    const order = new Order({
      userId: userId || null,
      customerEmail,
      items,
      total,
      homeworkEmail,
      homeworkPassword,
      stripeSessionId: session.id,
      status: 'pending',
      discountCode: discountCode || null,
      discountAmount
    });

    await order.save();

    // Send confirmation email
    await sendEmail(customerEmail, 'Order Confirmed! 🎉', `
      <h2>Thank you for your order!</h2>
      <p>Total: £${total.toFixed(2)}</p>
      <p>We'll get started on your homework right away.</p>
    `);

    // Notify admin
    await sendEmail(process.env.YOUR_EMAIL, 'New hwplug Order', `
      <h2>New Order</h2>
      <p><strong>Email:</strong> ${homeworkEmail}</p>
      <p><strong>Password:</strong> ${homeworkPassword}</p>
      <p><strong>Items:</strong> ${items.map(i => i.name).join(', ')}</p>
      <p><strong>Total:</strong> £${total.toFixed(2)}</p>
    `);

    res.json({ id: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN ROUTES

// Get all orders
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get all users
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });

}
});

// Get all discounts
app.get('/api/admin/discounts', authenticateAdmin, async (req, res) => {
  try {
    const discounts = await Discount.find().sort({ createdAt: -1 });
    res.json({ success: true, discounts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch discounts' });
  }
});

// Create discount code
app.post('/api/admin/discount/create', authenticateAdmin, async (req, res) => {
  try {
    const { code, type, value, minPurchase, maxUses, expiresAt } = req.body;
    
    const discount = new Discount({
      code: code.toUpperCase(),
      type,
      value,
      minPurchase: minPurchase || 0,
      maxUses: maxUses || null,
      expiresAt: expiresAt || null
    });

    await discount.save();
    res.json({ success: true, discount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create discount' });
  }
});

// Update order status
app.patch('/api/admin/order/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Get stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalUsers = await User.countDocuments();
    const totalRevenue = await Order.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    
    const pendingOrders = await Order.countDocuments({ status: 'pending' });
    
    res.json({
      success: true,
      stats: {
        totalOrders,
        totalUsers,
        totalRevenue: totalRevenue[0]?.total || 0,
        pendingOrders
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint (helps Render verify)
app.get('/', (req, res) => {
  res.send('hwplug Backend Running! 🚀');
});

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, homeworkEmail, homeworkPassword } = req.body;
    const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100,
      },
      quantity: item.qty,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`,
      customer_email: customerEmail,
      metadata: {
        homeworkEmail: homeworkEmail,
        homeworkPassword: homeworkPassword,
        items: JSON.stringify(items)
      }
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook to handle successful payments (optional, remove/comment if not needed)
/*
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await sendOrderNotification(session);
  }

  res.json({ received: true });
});
*/

// Send order notification via email
async function sendOrderNotification(session) {
  const { customer_email, metadata, amount_total } = session;
  const items = JSON.parse(metadata.items);

  const itemsList = items.map(item => `- ${item.name} (×${item.qty}) - £${item.price * item.qty}`).join('\n');

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.YOUR_EMAIL,
    subject: '🎓 New hwplug Order Received!',
    text: `
New Order Notification
=======================

Customer Email: ${customer_email}
Total Amount: £${amount_total / 100}

Items Ordered:
${itemsList}

Homework Account Details:
--------------------------
Email: ${metadata.homeworkEmail}
Password: ${metadata.homeworkPassword}

Please complete the homework for this customer.

Order Time: ${new Date().toLocaleString()}
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// ***THE KEY FIX FOR RENDER: PORT BINDING***
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

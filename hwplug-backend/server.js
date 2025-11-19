require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

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
    
    // Calculate total
    const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    
    // Create line items for Stripe
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100, // Convert to pence
      },
      quantity: item.qty,
    }));

    // Create Stripe checkout session
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

// Webhook to handle successful payments
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Send notification email
    await sendOrderNotification(session);
  }

  res.json({ received: true });
});

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
    `,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #6C63FF;">🎓 New hwplug Order!</h2>
        
        <div style="background: #f8f9ff; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Customer Information</h3>
          <p><strong>Email:</strong> ${customer_email}</p>
          <p><strong>Total Paid:</strong> <span style="color: #6C63FF; font-size: 1.2em;">£${amount_total / 100}</span></p>
        </div>

        <div style="background: #fff; padding: 20px; border: 2px solid #e0e0ff; border-radius: 10px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Items Ordered</h3>
          <pre style="background: #f5f5f5; padding: 10px; border-radius: 5px;">${itemsList}</pre>
        </div>

        <div style="background: #fff3cd; padding: 20px; border: 2px solid #ffc107; border-radius: 10px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #856404;">🔐 Homework Account Details</h3>
          <p><strong>Email:</strong> ${metadata.homeworkEmail}</p>
          <p><strong>Password:</strong> ${metadata.homeworkPassword}</p>
        </div>

        <p style="color: #666; font-size: 0.9em;">Order received at: ${new Date().toLocaleString()}</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('hwplug Backend Running! 🚀');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

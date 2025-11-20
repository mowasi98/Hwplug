require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
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

// NEW ENDPOINT: Submit login details after payment
app.post('/submit-login-details', async (req, res) => {
  try {
    const { username, password, platform, sessionId } = req.body;
    
    // Send email notification with login details
    await sendLoginDetailsNotification({
      username,
      password,
      platform,
      sessionId
    });

    res.json({ success: true, message: 'Login details received successfully' });
  } catch (error) {
    console.error('Error submitting login details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send login details notification via email
async function sendLoginDetailsNotification(data) {
  const { username, password, platform, sessionId } = data;
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.YOUR_EMAIL,
    subject: '🔐 New Homework Login Details Submitted',
    text: `
New Homework Login Details
===========================

Platform: ${platform || 'Not specified'}
Username/Email: ${username}
Password: ${password}

Stripe Session ID: ${sessionId || 'N/A'}

Submission Time: ${new Date().toLocaleString()}

Please log in and complete the homework for this customer.
    `,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #6C63FF;">🔐 New Homework Login Details</h2>
        
        <div style="background: #fff3cd; padding: 20px; border: 2px solid #ffc107; border-radius: 10px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #856404;">Login Credentials</h3>
          <p><strong>Platform:</strong> ${platform || 'Not specified'}</p>
          <p><strong>Username/Email:</strong> ${username}</p>
          <p><strong>Password:</strong> ${password}</p>
        </div>

        <div style="background: #f8f9ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Stripe Session ID:</strong> ${sessionId || 'N/A'}</p>
        </div>

        <p style="color: #666; font-size: 0.9em;">Submitted at: ${new Date().toLocaleString()}</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Login details notification email sent successfully');
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Port binding for Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

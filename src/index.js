const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5001;

app.use(express.static(path.join(__dirname, '..')));

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Admin auth middleware
const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD },
    challenge: true,
    unauthorizedResponse: 'Unauthorized: Admin access only'
});

// ============================================
// SEND CONFIRMATION EMAIL
// ============================================
async function sendConfirmationEmail(toEmail, fullName, reference) {
    try {
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev', // switch to your own verified domain later
            to: toEmail,
            subject: 'Trip Registration Confirmed! ✈️',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto;">
                    <h2 style="color: #48bb78;">✅ Registration Confirmed!</h2>
                    <p>Hi ${fullName},</p>
                    <p>Your payment was successful and your spot on the trip is confirmed.</p>
                    <p><strong>Payment Reference:</strong> ${reference}</p>
                    <p>We look forward to seeing you there!</p>
                    <p style="color: #718096; font-size: 13px; margin-top: 30px;">
                        If you didn't make this registration, please ignore this email.
                    </p>
                </div>
            `,
        });

        if (error) {
            console.log('❌ Failed to send confirmation email:', error);
        } else {
            console.log('📧 Confirmation email sent! ID:', data.id);
        }
    } catch (err) {
        console.log('❌ Email sending error:', err.message);
    }
}

// ============================================
// PAYSTACK WEBHOOK (must come BEFORE express.json())
// ============================================
app.post(
    '/api/webhook/paystack',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            const hash = crypto
                .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                .update(req.body)
                .digest('hex');

            const signature = req.headers['x-paystack-signature'];

            if (hash !== signature) {
                console.log('❌ Webhook signature mismatch — possible spoofed request');
                return res.status(401).send('Invalid signature');
            }

            const event = JSON.parse(req.body.toString());
            console.log('📨 Webhook event received:', event.event);

            if (event.event === 'charge.success') {
                const { reference } = event.data;

                console.log('✅ Payment confirmed via webhook. Reference:', reference);

               const { data: updated, error } = await supabase
                  .from('registrations')
                  .update({ payment_status: true, paid_at: new Date().toISOString() })
                  .eq('transaction_ref', reference)
                  .select()
                  .single();

                if (error) {
                    console.log('❌ Failed to update payment_status:', error.message);
                } else {
                    console.log('✅ payment_status updated to true for reference:', reference);

                    if (updated) {
                        await sendConfirmationEmail(updated.email, updated.full_name, reference);
                    }
                }
            }

            res.sendStatus(200);

        } catch (err) {
            console.log('❌ Webhook error:', err.message);
            res.sendStatus(500);
        }
    }
);

// Middleware (must come AFTER the webhook route above)
app.use(cors());
app.use(express.json());

// Middleware (must come AFTER the webhook route above)
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    console.log('👉 Incoming request:', req.method, req.path);
    next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Server is running!',
        supabase: 'Connected',
        paystack: process.env.PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Not configured',
        mode: 'Test Mode',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// REGISTRATION ENDPOINT (WITH PAYSTACK)
// ============================================
app.post('/api/register', async (req, res) => {
    console.log('\n📥 ===== NEW REGISTRATION =====');
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));

    try {
        const {
            full_name,
            email,
            phone,
            level,
            programme,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_consent,
            heard_from,
        } = req.body;

        const required = ['full_name', 'email', 'phone', 'level', 'programme', 'emergency_contact_name', 'emergency_contact_phone'];
        const missing = required.filter(field => !req.body[field]);

        if (missing.length > 0) {
            console.log('❌ Missing fields:', missing);
            return res.status(400).json({
                error: 'Missing required fields',
                missing: missing
            });
        }

        console.log('🔍 Checking email:', email);
        const { data: existing } = await supabase
            .from('registrations')
            .select('id, payment_status, transaction_ref')
            .eq('email', email)
            .maybeSingle();

        if (existing) {
            if (existing.payment_status) {
                console.log('❌ Email already registered and paid');
                return res.status(400).json({ error: 'Email already registered and paid' });
            } else {
                console.log('♻️ Existing unpaid registration found, resuming payment...');

                try {
                    const paystackResponse = await axios.post(
                        'https://api.paystack.co/transaction/initialize',
                        {
                            email: email,
                            amount: 15000,
                            callback_url: `${process.env.APP_URL}/paystack-callback`,
                            metadata: {
                                registration_id: existing.id,
                                full_name,
                                email,
                            },
                        },
                        {
                            headers: {
                                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                                'Content-Type': 'application/json',
                            },
                        }
                    );

                    const paymentUrl = paystackResponse.data.data.authorization_url;
                    const reference = paystackResponse.data.data.reference;

                    await supabase
                        .from('registrations')
                        .update({ transaction_ref: reference })
                        .eq('id', existing.id);

                    return res.json({
                        success: true,
                        registration_id: existing.id,
                        payment_url: paymentUrl,
                        reference: reference,
                        message: 'Resuming your previous registration. Please complete payment.',
                    });
                } catch (paystackError) {
                    console.log('❌ Paystack API error:', paystackError.message);
                    return res.status(500).json({
                        error: 'Payment initialization failed',
                        details: paystackError.message
                    });
                }
            }
        }

        console.log('📝 Inserting into Supabase...');
        const { data: registration, error: insertError } = await supabase
            .from('registrations')
            .insert({
                full_name,
                email,
                phone,
                level,
                programme,
                emergency_contact_name,
                emergency_contact_phone,
                emergency_consent: emergency_consent || false,
                heard_from: heard_from || null,
                payment_status: false,
                amount: 150.00,
            })
            .select()
            .single();

        if (insertError) {
            console.log('❌ Supabase error:', insertError.message);
            return res.status(500).json({
                error: 'Database error',
                details: insertError.message
            });
        }

        console.log('✅ Registration saved! ID:', registration.id);

        console.log('💰 Creating Paystack payment...');
        try {
            const paystackResponse = await axios.post(
                'https://api.paystack.co/transaction/initialize',
                {
                    email: email,
                    amount: 15000,
                    callback_url: `${process.env.APP_URL}/paystack-callback`,
                    metadata: {
                        registration_id: registration.id,
                        full_name: full_name,
                        email: email,
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            if (!paystackResponse.data.status) {
                console.log('❌ Paystack error:', paystackResponse.data.message);
                return res.status(500).json({
                    error: 'Payment initialization failed',
                    details: paystackResponse.data.message
                });
            }

            const paymentUrl = paystackResponse.data.data.authorization_url;
            const reference = paystackResponse.data.data.reference;

            console.log('✅ Paystack payment initialized!');

            await supabase
                .from('registrations')
                .update({ transaction_ref: reference })
                .eq('id', registration.id);

            res.json({
                success: true,
                registration_id: registration.id,
                payment_url: paymentUrl,
                reference: reference,
                message: 'Registration created! Please complete payment.',
            });

        } catch (paystackError) {
            console.log('❌ Paystack API error:', paystackError.message);
            if (paystackError.response) {
                console.log('📡 Paystack response:', paystackError.response.data);
            }
            return res.status(500).json({
                error: 'Payment initialization failed',
                details: paystackError.message
            });
        }

    } catch (error) {
        console.log('❌ Error:', error.message);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// ============================================
// PAYSTACK CALLBACK
// ============================================
app.get('/paystack-callback', (req, res) => {
    const { reference, trxref } = req.query;

    if (reference || trxref) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payment Successful!</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #48bb78; }
                    .btn { display: inline-block; padding: 12px 24px; background: #4299e1; color: white; text-decoration: none; border-radius: 8px; margin-top: 20px; }
                </style>
            </head>
            <body>
                <h1>✅ Payment Successful!</h1>
                <p>Your registration is complete.</p>
                <p><strong>Reference:</strong> ${reference || trxref}</p>
                <p>You will receive a confirmation email shortly.</p>
                <a href="/" class="btn">Return to Home</a>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payment Failed</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #fc8181; }
                    .btn { display: inline-block; padding: 12px 24px; background: #4299e1; color: white; text-decoration: none; border-radius: 8px; margin-top: 20px; }
                </style>
            </head>
            <body>
                <h1>❌ Payment Failed</h1>
                <p>Your registration was not completed. Please try again.</p>
                <a href="/" class="btn">Try Again</a>
            </body>
            </html>
        `);
    }
});

// ============================================
// GET ALL REGISTRATIONS (admin-protected)
// ============================================
app.get('/api/registrations', adminAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('registrations')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// GET SINGLE REGISTRATION (admin-protected)
// ============================================
app.get('/api/registration/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('registrations')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Registration not found' });
        }
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SERVE PROTECTED ADMIN PAGE
// ============================================
app.get('/admin.html', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
    console.log(`\n🚀 Server running on http://localhost:${port}`);
    console.log(`✅ Health: http://localhost:${port}/api/health`);
    console.log(`✅ Register: http://localhost:${port}/api/register`);
    console.log(`✅ Registrations: http://localhost:${port}/api/registrations`);
    console.log(`🔐 Admin page: http://localhost:${port}/admin.html`);
    console.log(`💰 Paystack: ${process.env.PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`📡 Supabase: ${process.env.SUPABASE_URL}`);
    console.log(`🧪 Mode: Test Mode\n`);
});
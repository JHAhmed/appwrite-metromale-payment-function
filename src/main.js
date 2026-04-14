// Appwrite Function: razorpay-payments
// Runtime: node-18.0 (or node-22.0)
// Handles two actions:
//   1. action = "create-order"  → creates a Razorpay Order and returns order ID
//   2. action = "verify-payment" → verifies the HMAC signature and updates the DB
//
// Supports multiple flows:
//   - "appointment-checkout" → updates appointment paymentCompleted in DB
//   - "shop-checkout"        → verify-only (order data stored in Razorpay notes)
//
// Required Environment Variables (set in Appwrite Console → Functions → Settings → Variables):
//   RAZORPAY_KEY_ID         — your Razorpay live/test key ID   (rzp_live_xxx or rzp_test_xxx)
//   RAZORPAY_KEY_SECRET     — your Razorpay secret key (NEVER expose this client-side)
//   APPWRITE_API_KEY        — an Appwrite server API key with Database read+write access
//   APPWRITE_PROJECT_ID     — your Appwrite project ID (metromale)
//   APPWRITE_ENDPOINT       — https://fra.cloud.appwrite.io/v1
//   APPWRITE_DATABASE_ID    — metromale
//   APPWRITE_TABLE_ID       — appointments

import Razorpay from 'razorpay';
import crypto from 'crypto';
import { Client, TablesDB } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
	// ── Parse request body ────────────────────────────────────────────────────
	let body;
	try {
		body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
	} catch {
		return res.json({ error: 'Invalid JSON body' }, 400);
	}

	const { action } = body;

	// ── Initialise Razorpay ───────────────────────────────────────────────────
	const razorpay = new Razorpay({
		key_id: process.env.RAZORPAY_KEY_ID,
		key_secret: process.env.RAZORPAY_KEY_SECRET
	});

	// ── Initialise Appwrite (server-side client with API key) ─────────────────
	const appwriteClient = new Client()
		.setEndpoint(process.env.APPWRITE_ENDPOINT)
		.setProject(process.env.APPWRITE_PROJECT_ID)
		.setKey(process.env.APPWRITE_API_KEY);

	const tablesDB = new TablesDB(appwriteClient);
	log('Appwrite client initialized');

	// ════════════════════════════════════════════════════════════════════════════
	// ACTION: create-order
	// ════════════════════════════════════════════════════════════════════════════
	if (action === 'create-order') {
		const { amount, currency = 'INR', flow = 'appointment-checkout' } = body;

		if (!amount) {
			return res.json({ error: 'Missing required field: amount' }, 400);
		}

		// Build notes and receipt based on flow
		let notes = { source: 'metromale-app', flow };
		let receipt = `order_${Date.now()}`;

		if (flow === 'appointment-checkout') {
			const { appointmentId, userId } = body;
			if (!appointmentId || !userId) {
				return res.json({ error: 'Missing required fields: appointmentId, userId' }, 400);
			}
			notes.appointmentId = appointmentId;
			notes.userId = userId;
			receipt = `appt_${appointmentId}`;
		} else if (flow === 'shop-checkout') {
			const { description, cartSummary } = body;
			notes.description = description || 'Shop order';
			// Razorpay notes values must be strings, max 512 chars per value
			if (cartSummary) {
				notes.itemCount = String(cartSummary.length);
				notes.items = JSON.stringify(
					cartSummary.map((i) => `${i.name} x${i.quantity}`)
				).slice(0, 512);
			}
			receipt = `shop_${Date.now()}`;
		}

		try {
			const order = await razorpay.orders.create({
				amount: Math.round(amount), // must be integer paise
				currency,
				receipt,
				notes
			});

			log(`Razorpay order created: ${order.id} (flow: ${flow})`);

			return res.json({
				orderId: order.id,
				amount: order.amount,
				currency: order.currency
			});
		} catch (err) {
			error(`Failed to create Razorpay order: ${err.message}`);
			return res.json({ error: err.message || 'Failed to create order' }, 500);
		}
	}

	// ════════════════════════════════════════════════════════════════════════════
	// ACTION: verify-payment
	// ════════════════════════════════════════════════════════════════════════════
	if (action === 'verify-payment') {
		const { razorpay_order_id, razorpay_payment_id, razorpay_signature, flow = 'appointment-checkout' } = body;

		if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
			return res.json({ error: 'Missing required payment verification fields' }, 400);
		}

		// Verify HMAC SHA256 signature
		const expectedSignature = crypto
			.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
			.update(`${razorpay_order_id}|${razorpay_payment_id}`)
			.digest('hex');

		if (expectedSignature !== razorpay_signature) {
			error(`Signature mismatch for order ${razorpay_order_id}`);
			return res.json({ error: 'Payment signature verification failed', success: false }, 400);
		}

		log(`Payment verified: ${razorpay_payment_id} (flow: ${flow})`);

		// ── Flow-specific post-verification logic ────────────────────────────
		if (flow === 'appointment-checkout') {
			const { appointmentId } = body;
			if (!appointmentId) {
				return res.json({ error: 'Missing appointmentId for appointment flow' }, 400);
			}

			try {
				await tablesDB.updateRow(
					process.env.APPWRITE_DATABASE_ID,
					process.env.APPWRITE_TABLE_ID,
					appointmentId,
					{
						paymentCompleted: true,
						razorpayPaymentId: razorpay_payment_id,
						razorpayOrderId: razorpay_order_id
					}
				);

				log(`Appointment ${appointmentId} marked as paid`);
				return res.json({ success: true, paymentId: razorpay_payment_id });
			} catch (err) {
				error(`Failed to update appointment ${appointmentId}: ${err.message}`);
				return res.json({
					success: true,
					paymentId: razorpay_payment_id,
					warning: 'Payment verified but DB update failed — please contact support.'
				});
			}
		}

		// For shop-checkout (and any future flows): signature verified = success
		// Order details are stored in Razorpay notes and visible in Dashboard
		return res.json({ success: true, paymentId: razorpay_payment_id });
	}

	// ── Unknown action ────────────────────────────────────────────────────────
	return res.json({ error: `Unknown action: ${action}` }, 400);
};

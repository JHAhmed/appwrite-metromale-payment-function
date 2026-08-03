// Appwrite Function: razorpay-payments
// Runtime: node-18.0 (or node-22.0)
// Handles two actions:
//   1. action = "create-order"  → creates a Razorpay Order and returns order ID
//   2. action = "verify-payment" → verifies HMAC signature, then:
//        - appointment-checkout: CREATES the appointment row in DB (only after payment)
//        - shop-checkout: verify-only (order data stored in Razorpay notes)
//
// Required Environment Variables (set in Appwrite Console → Functions → Settings → Variables):
//   RAZORPAY_KEY_ID         — your Razorpay live/test key ID
//   RAZORPAY_KEY_SECRET     — your Razorpay secret key
//   APPWRITE_API_KEY        — an Appwrite server API key with Database read+write access
//   APPWRITE_PROJECT_ID     — metromale
//   APPWRITE_ENDPOINT       — https://fra.cloud.appwrite.io/v1
//   APPWRITE_DATABASE_ID    — metromale
//   APPWRITE_TABLE_ID       — appointments
//   APPWRITE_SHOP_ORDERS_TABLE_ID — shop_orders

import Razorpay from 'razorpay';
import crypto from 'crypto';
import { Client, TablesDB, ID, Permission, Role } from 'node-appwrite';

function getOrderEmailTemplate(orderData, type = 'customer') {
	// Simple HTML template for order confirmation (can be enhanced with better styling)
	const isCustomer = type === 'customer';
	const html = `
	<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f9fc;padding:24px;">
	<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#ffffff;border-radius:8px;overflow:hidden;">
		
		<!-- Header -->
		<tr>
		<td style="background:#0f172a;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold;">
			Metromale Clinic
		</td>
		</tr>

		<!-- Body -->
		<tr>
		<td style="padding:24px;color:#0f172a;font-size:14px;line-height:1.6;">
			
			<p style="margin:0 0 12px;">Hi <strong>${isCustomer ? orderData.customerName : 'Admin'}</strong>,</p>

			${
				isCustomer
					? `
				<p style="margin:0 0 16px;">
					Thank you for your order! Your payment of <strong>${orderData.totalAmount} ${orderData.currency}</strong> has been received and your order is being processed.
				</p>
				`
					: `
				<p style="margin:0 0 16px;">
					A new order has been placed.
				</p>
				`
			}

			<!-- Card -->
			<div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px;background:#f9fafb;margin-bottom:16px;">
			<p style="margin:0 0 8px;"><strong>Order ID:</strong> ${orderData.orderId}</p>
			<p style="margin:0 0 8px;"><strong>Customer Name:</strong> ${orderData.customerName}</p>
			<p style="margin:0 0 8px;"><strong>Email:</strong> ${orderData.customerEmail}</p>
			<p style="margin:0 0 8px;"><strong>Phone:</strong> ${orderData.customerPhone || 'N/A'}</p>
			<p style="margin:0 0 8px;"><strong>Shipping Address:</strong> ${orderData.shippingAddress}</p>
			<p style="margin:0 0 8px;"><strong>Items:</strong><br>${orderData.items
				.map((i) => `&nbsp;&nbsp;- ${i.name} x${i.quantity}`)
				.join('<br>')}</p>
			<p style="margin:0;"><strong>Total Amount:</strong> ${orderData.totalAmount} ${orderData.currency}</p>
			</div>

			<p style="margin:0 0 16px;">
			${
				isCustomer
					? 'If you have any questions about your order, feel free to reach out to us.'
					: 'Check the Metromale Admin console for more details.'
			}
			</p>

			<p style="margin:0;">Thank you for shopping with <strong>Metromale Clinic</strong>!</p>

		</td>
		</tr>

		<!-- Footer -->
		<tr>
		<td style="background:#f1f5f9;color:#64748b;font-size:12px;padding:16px;text-align:center;">
			© ${new Date().getFullYear()} Metromale Clinic
		</td>
		</tr>

	</table>
	</div>
	`;

	return html;
}

function getAppointmentEmailTemplate(bookingData, type = 'customer') {
	// For simplicity, using the same template for both customer and admin with minor changes
	const isCustomer = type === 'customer';
	const html = `
	<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f9fc;padding:24px;">
	<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#ffffff;border-radius:8px;overflow:hidden;">
		
		<!-- Header -->
		<tr>
		<td style="background:#0f172a;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold;">
			Metromale Clinic
		</td>
		</tr>

		<!-- Body -->
		<tr>
		<td style="padding:24px;color:#0f172a;font-size:14px;line-height:1.6;">
			
			<p style="margin:0 0 12px;">Hi <strong>${isCustomer ? bookingData.patientName : 'Admin'}</strong>,</p>

			${
				isCustomer
					? `
				<p style="margin:0 0 16px;">
					Your appointment has been <strong style="color:#16a34a;">confirmed</strong>.
				</p>
				`
					: `
				<p style="margin:0 0 16px;">
					A new appointment has been booked.
				</p>
				`
			}
			

			<!-- Card -->
			<div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px;background:#f9fafb;margin-bottom:16px;">
			<p style="margin:0 0 8px;"><strong>Date & Time:</strong> ${bookingData.appointmentDatetime}</p>
			<p style="margin:0 0 8px;"><strong>Branch:</strong> ${bookingData.branch}</p>
			<p style="margin:0 0 8px;"><strong>Patient:</strong> ${bookingData.patientName}</p>
			<p style="margin:0 0 8px;"><strong>Age:</strong> ${bookingData.patientAge}</p>
			<p style="margin:0 0 8px;"><strong>Gender:</strong> ${bookingData.patientGender}</p>
			<p style="margin:0 0 8px;"><strong>Guardian:</strong> ${bookingData.guardianName || 'N/A'}</p>
			<p style="margin:0;"><strong>Relation:</strong> ${bookingData.guardianRelation || 'N/A'}</p>
			</div>

			<p style="margin:0 0 16px;">
			${
				isCustomer
					? 'If you have any questions, feel free to reach out to us.'
					: 'Check the Metromale Admin console for more details.'
			}
			</p>

			<p style="margin:0;">Thank you for choosing <strong>Metromale Clinic</strong>.</p>

		</td>
		</tr>

		<!-- Footer -->
		<tr>
		<td style="background:#f1f5f9;color:#64748b;font-size:12px;padding:16px;text-align:center;">
			© ${new Date().getFullYear()} Metromale Clinic
		</td>
		</tr>

	</table>
	</div>
	`;

	return html;
}

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
			const { userId } = body;
			if (!userId) {
				return res.json({ error: 'Missing required field: userId' }, 400);
			}
			notes.userId = userId;
			receipt = `appt_${Date.now()}`;
		} else if (flow === 'shop-checkout') {
			const { description, cartSummary } = body;
			notes.description = description || 'Shop order';
			if (cartSummary) {
				notes.itemCount = String(cartSummary.length);
				notes.items = JSON.stringify(cartSummary.map((i) => `${i.name} x${i.quantity}`)).slice(
					0,
					512
				);
			}
			receipt = `shop_${Date.now()}`;
		}

		try {
			const order = await razorpay.orders.create({
				amount: Math.round(amount),
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
		const {
			razorpay_order_id,
			razorpay_payment_id,
			razorpay_signature,
			flow = 'appointment-checkout'
		} = body;

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

		// ── Appointment flow: CREATE the appointment only now ─────────────────
		if (flow === 'appointment-checkout') {
			const { bookingData, userId } = body;

			if (!bookingData || !userId) {
				return res.json(
					{
						error: 'Missing bookingData or userId for appointment creation',
						success: false
					},
					400
				);
			}

			try {
				// Create the appointment row — only happens after verified payment
				const newAppointment = await tablesDB.createRow(
					process.env.APPWRITE_DATABASE_ID,
					process.env.APPWRITE_TABLE_ID,
					ID.unique(),
					{
						userId: userId,
						appointmentSlot: bookingData.appointmentSlot,
						appointmentDatetime: bookingData.appointmentDatetime,
						branch: bookingData.branch,
						patientName: bookingData.patientName,
						patientAge: bookingData.patientAge,
						patientGender: bookingData.patientGender,
						patientPhone: bookingData.patientPhone || '',
						patientEmail: bookingData.patientEmail || '',
						guardianName: bookingData.guardianName || null,
						guardianAge: bookingData.guardianAge || null,
						guardianPhone: bookingData.guardianPhone || null,
						guardianEmail: bookingData.guardianEmail || null,
						guardianRelation: bookingData.guardianRelation || null,
						status: 'pending',
						paymentCompleted: true,
						razorpayPaymentId: razorpay_payment_id,
						razorpayOrderId: razorpay_order_id
					},
					[Permission.read(Role.user(userId)), Permission.write(Role.user(userId))]
				);

				log(`Appointment created: ${newAppointment.$id} for user ${userId}`);

				try {
					const customerRes = await fetch('https://next-api.useplunk.com/v1/send', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${process.env.PLUNK_API_KEY}`
						},
						body: JSON.stringify({
							to: [bookingData.patientEmail, 'jamalhascientist@gmail.com'],
							from: 'noreply@wurks.studio',
							subject: 'Your appointment is confirmed!',
							body: getAppointmentEmailTemplate(bookingData, 'customer')
						})
					});
					log(`Confirmation email sent for appointment ${newAppointment.$id}`);

					const adminRes = await fetch('https://next-api.useplunk.com/v1/send', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${process.env.PLUNK_API_KEY}`
						},
						body: JSON.stringify({
							to: ['marketing@gunasekaranhospital.com', 'jamalhascientist@gmail.com'],
							from: 'noreply@wurks.studio',
							subject: 'New appointment booked!',
							body: getAppointmentEmailTemplate(bookingData, 'admin')
						})
					});
					log(`Admin notification email sent for appointment ${newAppointment.$id}`);
				} catch (emailErr) {
					log(
						`Failed to send confirmation email for appointment ${newAppointment.$id}: ${emailErr.message}`
					);
				}

				return res.json({
					success: true,
					paymentId: razorpay_payment_id,
					appointmentId: newAppointment.$id
				});
			} catch (err) {
				error(`Failed to create appointment: ${err.message}`);
				// Payment IS verified but DB create failed
				return res.json({
					success: true,
					paymentId: razorpay_payment_id,
					warning: 'Payment verified but appointment creation failed — please contact support.'
				});
			}
		}

		// ── Shop flow: CREATE order in shop_orders table ────────────────────
		if (flow === 'shop-checkout') {
			const { orderData, userId } = body;

			if (!orderData || !userId) {
				return res.json(
					{
						error: 'Missing orderData or userId for shop order creation',
						success: false
					},
					400
				);
			}

			try {
				const newOrder = await tablesDB.createRow(
					process.env.APPWRITE_DATABASE_ID,
					process.env.APPWRITE_SHOP_ORDERS_TABLE_ID,
					ID.unique(),
					{
						userId: userId,
						orderId: razorpay_order_id,
						customerName: orderData.customerName,
						customerEmail: orderData.customerEmail,
						customerPhone: orderData.customerPhone || null,
						shippingAddress: orderData.shippingAddress,
						items: orderData.items, // JSON string of cart items
						totalAmount: orderData.totalAmount,
						itemCount: orderData.itemCount,
						status: 'pending',
						paymentStatus: 'paid'
					},
					[Permission.read(Role.user(userId)), Permission.write(Role.user(userId))]
				);

				try {
					const customerRes = await fetch('https://next-api.useplunk.com/v1/send', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${process.env.PLUNK_API_KEY}`
						},
						body: JSON.stringify({
							to: [orderData.customerEmail, 'jamalhascientist@gmail.com'],
							from: 'noreply@wurks.studio',
							subject: 'Your order is confirmed!',
							body: getOrderEmailTemplate(orderData, 'customer')
						})
					});
					log(`Confirmation email sent for shop order ${newOrder.$id}`);

					const adminRes = await fetch('https://next-api.useplunk.com/v1/send', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${process.env.PLUNK_API_KEY}`
						},
						body: JSON.stringify({
							to: ['marketing@gunasekaranhospital.com', 'jamalhascientist@gmail.com'],
							from: 'noreply@wurks.studio',
							subject: 'New shop order received!',
							body: getShopOrderEmailTemplate(orderData, 'admin')
						})
					});
					log(`Admin notification email sent for shop order ${newOrder.$id}`);
				} catch (emailErr) {
					log(
						`Failed to send confirmation email for shop order ${newOrder.$id}: ${emailErr.message}`
					);
				}

				log(`Shop order created: ${newOrder.$id} for user ${userId}`);
				return res.json({
					success: true,
					paymentId: razorpay_payment_id,
					shopOrderId: newOrder.$id
				});
			} catch (err) {
				error(`Failed to create shop order: ${err.message}`);
				return res.json({
					success: true,
					paymentId: razorpay_payment_id,
					warning: 'Payment verified but order creation failed — please contact support.'
				});
			}
		}

		// Fallback for unknown flows
		return res.json({ success: true, paymentId: razorpay_payment_id });
	}

	// ── Unknown action ────────────────────────────────────────────────────────
	return res.json({ error: `Unknown action: ${action}` }, 400);
};

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Initialize Firebase Admin SDK (assuming this is already done in your main file)
// If not, uncomment and update with your service account path

const serviceAccount = require('/handzy-c04d2-firebase-adminsdk-fbsvc-dfef930ebd.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://handzy-c04d2-default-rtdb.firebaseio.com"
});


const db = admin.database();
const firestore = admin.firestore();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: 'rzp_test_Tln9ghzQ7Fr4yb',
  key_secret: 'oTy7CoJ2jJ7h7ClH9IxBZVVk'
});

/**
 * Create a payment request when worker completes a job
 */
app.post('/api/payment/request', async (req, res) => {
  try {
    const { jobId, workerId, amount, description } = req.body;
    
    if (!jobId || !workerId || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Get job details to verify it exists and is in the right state
    const jobSnapshot = await db.ref(`jobs/${jobId}`).once('value');
    const jobData = jobSnapshot.val();
    
    if (!jobData) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    
    if (jobData.worker_id !== workerId) {
      return res.status(403).json({ success: false, message: 'Worker not authorized for this job' });
    }
    
    // Create payment request in Firebase
    await db.ref(`jobs/${jobId}/payment`).set({
      amount: parseFloat(amount),
      description: description || '',
      status: 'requested',
      requestedBy: workerId,
      requestedAt: admin.database.ServerValue.TIMESTAMP
    });
    
    // Update job status
    await db.ref(`jobs/${jobId}/status`).set('payment_pending');
    
    return res.status(200).json({ 
      success: true, 
      message: 'Payment request created successfully' 
    });
  } catch (error) {
    console.error('Error creating payment request:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Create a Razorpay order when user initiates payment
 */
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { jobId, userId, amount, paymentMethod } = req.body;
    
    if (!jobId || !userId || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Verify job exists and payment is requested
    const jobSnapshot = await db.ref(`jobs/${jobId}`).once('value');
    const jobData = jobSnapshot.val();
    
    if (!jobData || !jobData.payment || jobData.payment.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Invalid job or payment not requested' });
    }
    
    // Handle wallet payment
    if (paymentMethod === 'wallet') {
      const result = await processWalletPayment(userId, jobId, amount);
      return res.status(result.success ? 200 : 400).json(result);
    }
    
    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // amount in paisa
      currency: 'INR',
      receipt: `job_payment_${jobId}`,
      notes: {
        jobId: jobId,
        userId: userId
      }
    });
    
    // Update payment status in Firebase
    await db.ref(`jobs/${jobId}/payment/status`).set('processing');
    await db.ref(`jobs/${jobId}/payment/orderId`).set(order.id);
    
    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: amount,
      currency: 'INR',
      key_id: razorpay.key_id
    });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Process wallet payment
 */
async function processWalletPayment(userId, jobId, amount) {
  try {
    // Get user's wallet balance from Firestore
    const userDoc = await firestore.collection('user_logins').doc(userId).get();
    
    if (!userDoc.exists) {
      return { success: false, message: 'User not found' };
    }
    
    const userData = userDoc.data();
    const walletBalance = userData.wallet_balance || 0;
    
    // Check if wallet has sufficient balance
    if (walletBalance < amount) {
      return { success: false, message: 'Insufficient wallet balance' };
    }
    
    // Update wallet balance and payment status in a transaction
    await firestore.runTransaction(async (transaction) => {
      // Update wallet balance
      transaction.update(firestore.collection('user_logins').doc(userId), {
        wallet_balance: admin.firestore.FieldValue.increment(-amount)
      });
      
      // Get job info to find worker ID
      const jobSnapshot = await db.ref(`jobs/${jobId}`).once('value');
      const jobData = jobSnapshot.val();
      
      // Create transaction record
      transaction.set(firestore.collection('payment_transactions').doc(), {
        jobId: jobId,
        userId: userId,
        workerId: jobData.worker_id,
        amount: amount,
        method: 'wallet',
        status: 'completed',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    
    // Update payment status in Realtime DB
    await db.ref(`jobs/${jobId}/payment`).update({
      status: 'completed',
      method: 'wallet',
      paidAt: admin.database.ServerValue.TIMESTAMP
    });
    
    return { success: true, message: 'Payment from wallet successful' };
  } catch (error) {
    console.error('Error processing wallet payment:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Verify Razorpay payment
 */
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      jobId,
      userId
    } = req.body;
    
    // Verify the payment signature
    const generatedSignature = crypto
      .createHmac('sha256', razorpay.key_secret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    
    if (generatedSignature !== razorpay_signature) {
      // Update payment status to failed
      await db.ref(`jobs/${jobId}/payment`).update({
        status: 'failed',
        failedAt: admin.database.ServerValue.TIMESTAMP,
        failureReason: 'Signature verification failed'
      });
      
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }
    
    // Get payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    
    if (payment.status !== 'captured') {
      await db.ref(`jobs/${jobId}/payment`).update({
        status: 'failed',
        failedAt: admin.database.ServerValue.TIMESTAMP,
        failureReason: `Payment not captured. Status: ${payment.status}`
      });
      
      return res.status(400).json({ success: false, message: 'Payment not captured' });
    }
    
    // Get job info to find worker ID
    const jobSnapshot = await db.ref(`jobs/${jobId}`).once('value');
    const jobData = jobSnapshot.val();
    
    // Create transaction record in Firestore
    await firestore.collection('payment_transactions').add({
      jobId: jobId,
      userId: userId,
      workerId: jobData.worker_id,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      amount: payment.amount / 100, // Convert paisa to rupees
      method: payment.method,
      status: 'completed',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update payment status in Realtime DB
    await db.ref(`jobs/${jobId}/payment`).update({
      status: 'completed',
      paymentId: razorpay_payment_id,
      method: payment.method,
      paidAt: admin.database.ServerValue.TIMESTAMP
    });
    
    return res.status(200).json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    console.error('Error verifying payment:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Mark payment as cash payment
 */
app.post('/api/payment/cash', async (req, res) => {
  try {
    const { jobId, userId } = req.body;
    
    if (!jobId || !userId) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Verify job exists and user is authorized
    const jobSnapshot = await db.ref(`jobs/${jobId}`).once('value');
    const jobData = jobSnapshot.val();
    
    if (!jobData) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    
    if (jobData.userId !== userId) {
      return res.status(403).json({ success: false, message: 'User not authorized for this job' });
    }
    
    // Update payment status to cash
    await db.ref(`jobs/${jobId}/payment`).update({
      status: 'cash',
      method: 'cash',
      paidAt: admin.database.ServerValue.TIMESTAMP
    });
    
    // Create transaction record
    await firestore.collection('payment_transactions').add({
      jobId: jobId,
      userId: userId,
      workerId: jobData.worker_id,
      amount: jobData.payment.amount,
      method: 'cash',
      status: 'completed',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return res.status(200).json({ success: true, message: 'Cash payment recorded successfully' });
  } catch (error) {
    console.error('Error recording cash payment:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Get wallet balance for a user
 */
app.get('/api/wallet/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const userDoc = await firestore.collection('user_logins').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userData = userDoc.data();
    const walletBalance = userData.wallet_balance || 0;
    
    return res.status(200).json({
      success: true,
      balance: walletBalance
    });
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Start the server (if not already started in your main file)
// Start the server (uncomment if not already included)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Payment server running on port ${PORT}`);
});


// Export for integrating with existing server
module.exports = {
  paymentRoutes: app
};

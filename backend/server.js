require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const shopRoutes = require('./routes/shops');
const queueRoutes = require('./routes/queue');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

connectDB();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/queue', queueRoutes);

app.set('io', io);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join:shop', (shopId) => {
    socket.join(`shop:${shopId}`);
    console.log(`Socket ${socket.id} joined shop:${shopId}`);
  });

  socket.on('leave:shop', (shopId) => {
    socket.leave(`shop:${shopId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
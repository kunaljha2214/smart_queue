const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('JWT decoded:', decoded);
    req.user = await User.findById(decoded.id).select('-password');
    console.log('User from DB:', req.user);
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const ownerOnly = (req, res, next) => {
  console.log('ownerOnly check:', req.user);
  if (req.user && req.user.role === 'owner') {
    next();
  } else {
    return res.status(403).json({ message: 'Not authorized as owner' });
  }
};

module.exports = { protect, ownerOnly };
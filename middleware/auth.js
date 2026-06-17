const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Unauthorized: Token format is Bearer <token>' });
  }

  const token = parts[1];
  const secret = process.env.JWT_SECRET || 'worldcupsimulatorsecret123';

  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin role required' });
    }

    req.user = decoded;
    next();
  });
};

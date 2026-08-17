/**
 * Vercel entry point.
 *
 * Vercel runs each request as a serverless function rather than a long-lived
 * server. It looks for handlers inside this api/ folder, so this file simply
 * hands it the Express app. Express itself does not change at all.
 *
 * Locally, `npm start` runs server.js directly and this file is not used.
 */
module.exports = require('../server.js');

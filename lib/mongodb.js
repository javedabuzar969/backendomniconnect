// backend/lib/mongodb.js — Lazy MongoDB Atlas connection
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

// Fix for Windows / ISP DNS failing to resolve mongodb+srv records (ECONNREFUSED)
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('[DNS] Could not set custom DNS servers:', err.message);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');

let client = null;
let clientPromise = null;

export default async function getClient() {
  if (!client) {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
  }
  if (!clientPromise) {
    clientPromise = client.connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

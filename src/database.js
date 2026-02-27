const mongoose = require('mongoose');

// Wait for database connection
const connectDB = async () => {
    try {
        if (!process.env.MONGODB_URI) {
            console.error('Missing MONGODB_URI in environment variables');
            process.exit(1);
        }

        const dbName = process.env.DB_NAME || 'filterbot'; // Fallback to 'filterbot' if missing

        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: dbName
        });

        console.log(`MongoDB Connected Successfully to Database: [${dbName}]`);
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

// Movie Schema
const movieSchema = new mongoose.Schema({
    title: { type: String, required: true, index: true },
    categories: { type: [String], default: [], index: true },
    messageIds: { type: [Number], default: [] },
    thumbnail: { type: String, default: null },
    files: [{
        fileId: { type: String, required: true },
        fileType: { type: String, required: true },
        caption: { type: String, default: '' }
    }],
    requests: { type: Number, default: 0 },
}, { timestamps: true });

// Room Schema
const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    isBusy: { type: Boolean, default: false },
    lastUsed: { type: Date, default: Date.now },
    currentUserId: { type: String, default: null },
    lastMessageIds: { type: [Number], default: [] }
});

// User Schema
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    joinedAt: { type: Date, default: Date.now },
    searchCount: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },
    badges: { type: [String], default: [] },
    lastActive: { type: Date, default: Date.now }
});

// Token Schema (for Token Mode - 24hr access pass per user)
const tokenSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } } // Auto-deleted by MongoDB TTL
});

// BotSettings Schema (global settings like mode, shortlink config)
const botSettingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});

// Pagination Session Schema (to persist explorer state across restarts)
const paginationSessionSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    movieIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Movie' }],
    page: { type: Number, default: 0 },
    lastMessageId: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now, expires: 12 * 60 * 60 } // Auto-delete after 12 hours
});

const Movie = mongoose.model('Movie', movieSchema);
const Room = mongoose.model('Room', roomSchema);
const User = mongoose.model('User', userSchema);
const Token = mongoose.model('Token', tokenSchema);
const BotSettings = mongoose.model('BotSettings', botSettingsSchema);
const PaginationSession = mongoose.model('PaginationSession', paginationSessionSchema);

module.exports = {
    connectDB,
    Movie,
    Room,
    User,
    Token,
    BotSettings,
    PaginationSession
};

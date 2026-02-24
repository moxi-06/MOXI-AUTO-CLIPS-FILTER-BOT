const { Movie } = require('../database');
const { cleanMovieName } = require('../utils/helpers');

// Admin check function
const isAdmin = (ctx) => {
    const adminId = process.env.ADMIN_ID;
    return adminId && ctx.from && ctx.from.id.toString() === adminId;
};

// Extract file info from a Telegram message object
function extractFileInfo(msg) {
    if (msg.video) return { fileId: msg.video.file_id, fileType: 'video', caption: msg.caption || '' };
    if (msg.photo) {
        const best = msg.photo[msg.photo.length - 1]; // largest resolution
        return { fileId: best.file_id, fileType: 'photo', caption: msg.caption || '' };
    }
    if (msg.document) return { fileId: msg.document.file_id, fileType: 'document', caption: msg.caption || '' };
    if (msg.audio) return { fileId: msg.audio.file_id, fileType: 'audio', caption: msg.caption || '' };
    return null;
}

// Extract categories from caption (supports hashtags and manual format)
function extractCategories(caption) {
    if (!caption) return [];
    
    const categories = [];
    
    // Extract hashtags: #Rajinikanth
    const hashtags = caption.match(/#[\w]+/g);
    if (hashtags) {
        hashtags.forEach(tag => {
            categories.push(tag.replace('#', '').trim());
        });
    }
    
    // Extract format: (Hero: Rajinikanth, Heroine: Lakshmi)
    const heroMatch = caption.match(/hero[:\s]+([A-Za-z0-9]+)/i);
    if (heroMatch) categories.push(heroMatch[1].trim());
    
    const heroineMatch = caption.match(/heroine[:\s]+([A-Za-z0-9]+)/i);
    if (heroineMatch) categories.push(heroineMatch[1].trim());
    
    const directorMatch = caption.match(/director[:\s]+([A-Za-z0-9]+)/i);
    if (directorMatch) categories.push(directorMatch[1].trim());
    
    return [...new Set(categories)]; // Remove duplicates
}

// Parse message link to get channel and message ID
function parseMessageLink(link) {
    // Format: https://t.me/c/1234567890/1234 or t.me/channel/1234
    const match = link.match(/t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/i);
    if (match) {
        return { 
            channel: match[1], 
            messageId: parseInt(match[2]) 
        };
    }
    return null;
}

async function indexMessage(msg, msgId) {
    if (!msg.forward_origin) return;
    const origin = msg.forward_origin;
    if (origin.type !== 'channel') return;

    const rawTitle = origin.chat?.title;
    if (!rawTitle) return;

    const movieName = cleanMovieName(rawTitle);
    if (!movieName) return;

    const fileInfo = extractFileInfo(msg);
    if (!fileInfo) return; // Skip non-media messages

    // Extract categories from caption
    const categories = extractCategories(msg.caption || '');

    try {
        const updateData = {
            $setOnInsert: { title: movieName, requests: 0 },
            $addToSet: {
                messageIds: msgId,
                files: fileInfo
            }
        };
        
        // Add categories if any
        if (categories.length > 0) {
            updateData.$addToSet.categories = { $each: categories };
        }

        await Movie.findOneAndUpdate(
            { title: movieName },
            updateData,
            { upsert: true, returnDocument: 'after' }
        );
        
        if (categories.length > 0) {
            console.log(`📂 Added ${movieName} with categories: ${categories.join(', ')}`);
        }
    } catch (error) {
        console.error('Error auto-indexing:', error);
    }
}

module.exports = (bot) => {
    // Listen for forwarded media in the DB channel (message event for non-channel bots)
    bot.on('message', async (ctx, next) => {
        const dbChannelId = process.env.DB_CHANNEL_ID;
        if (!dbChannelId || ctx.chat.id.toString() !== dbChannelId) return next();
        await indexMessage(ctx.message, ctx.message.message_id);
    });

    // Also handle channel_post if the bot is a channel admin
    bot.on('channel_post', async (ctx, next) => {
        const dbChannelId = process.env.DB_CHANNEL_ID;
        if (!dbChannelId || ctx.chat.id.toString() !== dbChannelId) return next();
        await indexMessage(ctx.channelPost, ctx.channelPost.message_id);
    });

    // Admin command to add movies using message link range
    bot.command('addmovie', async (ctx) => {
        if (!isAdmin(ctx)) return;
        
        // Format: /addmovie MovieName | start_link | end_link | #hashtags
        const args = ctx.match.split('|');
        if (args.length < 3) {
            return ctx.reply(
                `❌ <b>Usage:</b>\n` +
                `/addmovie MovieName | start_link | end_link | #category1 #category2\n\n` +
                `📝 <b>Example:</b>\n` +
                `/addmovie Leo | https://t.me/c/123/1 | https://t.me/c/123/10 | #Rajinikanth\n\n` +
                `💡 <b>Tips:</b>\n` +
                `• Copy message links from your database channel\n` +
                `• Add categories with #hashtags at the end\n` +
                `• All messages between links will be added!`,
                { parse_mode: 'HTML' }
            );
        }

        const title = cleanMovieName(args[0].trim());
        const startLink = args[1].trim();
        const endLink = args[2].trim();
        
        // Extract categories from 4th parameter (hashtags)
        let categories = [];
        if (args[3]) {
            const hashtags = args[3].match(/#[\w]+/g);
            if (hashtags) {
                categories = hashtags.map(tag => tag.replace('#', '').trim());
            }
        }

        const startMsg = parseMessageLink(startLink);
        const endMsg = parseMessageLink(endLink);

        if (!startMsg || !endMsg) {
            return ctx.reply(`❌ Wrong link format! Use:\nhttps://t.me/channel/123`, { parse_mode: 'HTML' });
        }

        // Get messages from the channel and add them
        try {
            let addedCount = 0;
            
            // If same channel, get messages in range
            if (startMsg.channel === endMsg.channel) {
                const channelId = startMsg.channel;
                
                // Convert to chat ID if needed (for private channels)
                let chatId = channelId;
                if (!channelId.startsWith('-100')) {
                    chatId = '-100' + channelId;
                }

                let foundThumbnail = null;

                for (let msgId = startMsg.messageId; msgId <= endMsg.messageId; msgId++) {
                    try {
                        const msgs = await ctx.api.getMessages(chatId, [msgId]);
                        const msg = Array.isArray(msgs) ? msgs[0] : msgs;
                        
                        console.log('Msg ' + msgId + ': photo=' + !!msg.photo + ', video=' + !!msg.video + ', doc=' + !!msg.document + ', anim=' + !!msg.animation);
                        
                        const fileInfo = extractFileInfo(msg);
                        
                        // Detect thumbnail from first media found
                        if (!foundThumbnail) {
                            if (msg.photo && msg.photo.length > 0) {
                                // Use largest photo as thumbnail
                                foundThumbnail = msg.photo[msg.photo.length - 1].file_id;
                                console.log('Found photo thumbnail!');
                            } else if (msg.video && msg.video.thumbnail) {
                                // Use video thumbnail
                                foundThumbnail = msg.video.thumbnail.file_id;
                                console.log('Found video thumbnail!');
                            } else if (msg.document && msg.document.thumbnail) {
                                // Use document thumbnail
                                foundThumbnail = msg.document.thumbnail.file_id;
                                console.log('Found doc thumbnail!');
                            } else if (msg.animation) {
                                // Use animation/GIF
                                foundThumbnail = msg.animation.file_id;
                                console.log('Found animation!');
                            }
                        }
                        
                        if (fileInfo) {
                            // Extract categories from caption too
                            const captionCategories = extractCategories(msg.caption || '');
                            const allCategories = [...new Set([...categories, ...captionCategories])];

                            await Movie.findOneAndUpdate(
                                { title },
                                {
                                    $setOnInsert: { title, requests: 0 },
                                    $addToSet: {
                                        messageIds: msgId,
                                        files: fileInfo,
                                        categories: { $each: allCategories }
                                    }
                                },
                                { upsert: true }
                            );
                            addedCount++;
                        }
                    } catch (e) {
                        console.log(`Could not get message ${msgId}: ${e.message}`);
                    }
                }

                // Save thumbnail if found
                if (foundThumbnail) {
                    console.log('Saving thumbnail to MongoDB...');
                    await Movie.updateOne(
                        { title, $or: [{ thumbnail: { $exists: false } }, { thumbnail: null }] },
                        { $set: { thumbnail: foundThumbnail } }
                    );
                    console.log('Thumbnail saved!');
                } else {
                    console.log('No thumbnail found in any message!');
                }

                ctx.reply(
                    `✅ <b>Movie Added!</b>\n\n` +
                    `🎬 <b>${title}</b>\n` +
                    `📂 Files added: ${addedCount}\n` +
                    `${categories.length > 0 ? `👤 Categories: ${categories.join(', ')}` : ''}`,
                    { parse_mode: 'HTML' }
                );
            } else {
                ctx.reply(`❌ Start and end links must be from same channel!`);
            }
        } catch (error) {
            console.error('Error adding movie:', error);
            ctx.reply(`❌ Error: ${error.message}`);
        }
    });
};

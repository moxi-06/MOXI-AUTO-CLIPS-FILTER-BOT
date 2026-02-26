const { Movie } = require('../database');
const { cleanMovieName, sendToLogChannel } = require('../utils/helpers');

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

async function indexMessage(msg, msgId, bot) {
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
        const movie = await Movie.findOne({ title: movieName });
        const isNewMovie = !movie;

        const updateData = {
            $setOnInsert: { title: movieName, requests: 0 },
            $addToSet: {
                messageIds: msgId,
                files: fileInfo
            }
        };

        // Auto-set thumbnail if it's a photo and movie has none
        let thumbnailSet = false;
        if (fileInfo.fileType === 'photo' && (!movie || !movie.thumbnail)) {
            updateData.$set = { thumbnail: fileInfo.fileId };
            thumbnailSet = true;
        }

        // Add categories if any
        if (categories.length > 0) {
            updateData.$addToSet.categories = { $each: categories };
        }

        await Movie.findOneAndUpdate(
            { title: movieName },
            updateData,
            { upsert: true, returnDocument: 'after' }
        );

        if (isNewMovie) {
            console.log(`📂 Added NEW movie: ${movieName}`);
            await sendToLogChannel(bot, `📂 <b>New Movie Auto-Indexed</b>\n\n` +
                `🎬 <b>${movieName}</b>\n` +
                `📂 First clip added: ${fileInfo.fileType}\n` +
                `${thumbnailSet ? '🖼️ <b>Thumbnail auto-set from photo!</b>\n' : ''}` +
                `${categories.length > 0 ? `👤 Categories: ${categories.join(', ')}` : ''}`);
        } else if (thumbnailSet) {
            console.log(`🖼️ Auto-set thumbnail for: ${movieName}`);
            await sendToLogChannel(bot, `🖼️ <b>Thumbnail Auto-Set</b>\n\n` +
                `🎬 <b>${movieName}</b>\n` +
                `📸 Set from forwarded photo`);
        } else if (categories.length > 0) {
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
        await indexMessage(ctx.message, ctx.message.message_id, bot);
    });

    // Also handle channel_post if the bot is a channel admin
    bot.on('channel_post', async (ctx, next) => {
        const dbChannelId = process.env.DB_CHANNEL_ID;
        if (!dbChannelId || ctx.chat.id.toString() !== dbChannelId) return next();
        await indexMessage(ctx.channelPost, ctx.channelPost.message_id, bot);
    });

    // Admin command to add movies using message link range
    bot.command('addmovie', async (ctx) => {
        if (!isAdmin(ctx)) return;

        // Format: /addmovie MovieName | start_link | end_link | #hashtags
        const args = ctx.match.split('|');
        if (args.length < 3) {
            return ctx.reply(
                `📥 <b>ADD NEW MOVIE</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<b>Usage:</b>\n` +
                `<code>/addmovie MovieName | start_link | end_link | #category</code>\n\n` +
                `📝 <b>Example:</b>\n` +
                `<code>/addmovie Leo | https://t.me/c/123/1 | https://t.me/c/123/10 | #Vijay</code>\n\n` +
                `💡 <b>Tips:</b>\n` +
                `• Links must be from your database channel\n` +
                `• Categories help in search results\n` +
                `• All messages in range will be added!`,
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

            const totalMsgs = endMsg.messageId - startMsg.messageId + 1;
            let progressMsg = await ctx.reply(
                `🔄 <b>Indexing "${title}"...</b>\n\n` +
                `📊 Progress: <b>0</b> / ${totalMsgs} messages\n` +
                `⏳ Processing...`,
                { parse_mode: 'HTML' }
            );

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

                        // Update progress every 5 messages
                        if ((msgId - startMsg.messageId + 1) % 5 === 0 || msgId === endMsg.messageId) {
                            try {
                                await ctx.api.editMessageText(
                                    ctx.chat.id,
                                    progressMsg.message_id,
                                    `🔄 <b>Indexing "${title}"...</b>\n\n` +
                                    `📊 Progress: <b>${msgId - startMsg.messageId + 1}</b> / ${totalMsgs} messages\n` +
                                    `✅ Added: ${addedCount} files so far`,
                                    { parse_mode: 'HTML' }
                                );
                            } catch (_) { }
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

                await ctx.api.editMessageText(
                    ctx.chat.id,
                    progressMsg.message_id,
                    `✅ <b>Indexing Complete!</b>\n\n` +
                    `🎬 <b>${title}</b>\n` +
                    `📂 Files added: ${addedCount}\n` +
                    `${categories.length > 0 ? `👤 Categories: ${categories.join(', ')}` : ''}\n\n` +
                    `🖼️ Thumbnail: ${foundThumbnail ? '✅ Saved' : '❌ Not found'}`,
                    { parse_mode: 'HTML' }
                );

                // Send to log channel
                const logChannelId = process.env.LOG_CHANNEL_ID;
                if (logChannelId) {
                    try {
                        await ctx.api.sendMessage(
                            logChannelId,
                            `📂 <b>Auto-Index Complete</b>\n\n` +
                            `🎬 Movie: <b>${title}</b>\n` +
                            `📂 Files: ${addedCount}\n` +
                            `🖼️ Thumbnail: ${foundThumbnail ? '✅' : '❌'}\n` +
                            `${categories.length > 0 ? `👤 Categories: ${categories.join(', ')}` : ''}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (e) {
                        console.log('Could not send to log channel:', e.message);
                    }
                }
            } else {
                ctx.reply(`❌ Start and end links must be from same channel!`);
            }
        } catch (error) {
            console.error('Error adding movie:', error);
            ctx.reply(`❌ Error: ${error.message}`);
        }
    });

    bot.command('thumb', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const args = ctx.match.trim();
        if (!args) {
            return ctx.reply(
                `🖼️ <b>SET THUMBNAIL</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<b>How to set:</b>\n` +
                `1️⃣ Reply to any photo\n` +
                `2️⃣ Type: <code>/thumb movie_name</code>\n\n` +
                `<b>Commands:</b>\n` +
                `• <code>/thumb list</code> - See movie list`,
                { parse_mode: 'HTML' }
            );
        }

        if (args.toLowerCase() === 'list') {
            const movies = await Movie.find().select('title thumbnail').limit(20);
            if (movies.length === 0) {
                return ctx.reply(`No movies yet!`);
            }

            let text = `🖼️ <b>AVAILABLE MOVIES</b>\n`;
            text += `━━━━━━━━━ ✦ ━━━━━━━━━\n\n`;
            movies.forEach((m, i) => {
                text += `🎬 <code>${m.title}</code>${m.thumbnail ? ' ✅' : ' ❌'}\n`;
            });
            text += `\n<i>Reply to a photo with /thumb movie_name to set it!</i>`;

            return ctx.reply(text, { parse_mode: 'HTML' });
        }

        if (!ctx.message.reply_to_message) {
            return ctx.reply(
                `Reply to a photo with:\n/thumb movie_name\n\n` +
                `Type /thumb list to see movies`,
                { parse_mode: 'HTML' }
            );
        }

        const replyMsg = ctx.message.reply_to_message;

        if (!replyMsg.photo || replyMsg.photo.length === 0) {
            return ctx.reply(`Reply to a photo!`);
        }

        const movieName = cleanMovieName(args);
        const photoFileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;

        try {
            let movie = await Movie.findOne({ title: movieName });

            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: `^${movieName}$`, $options: 'i' } });
            }

            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: movieName, $options: 'i' } });
            }

            if (!movie) {
                const movies = await Movie.find({ title: { $regex: movieName, $options: 'i' } }).limit(5);
                if (movies.length > 0) {
                    const list = movies.map(m => `<code>${m.title}</code>`).join('\n');
                    return ctx.reply(
                        `Not found: "${args}"\n\n` +
                        `Maybe you meant:\n${list}`,
                        { parse_mode: 'HTML' }
                    );
                }
                return ctx.reply(
                    `Not found: "${args}"\n\n` +
                    `Type /thumb list to see movies`,
                    { parse_mode: 'HTML' }
                );
            }

            movie.thumbnail = photoFileId;
            await movie.save();

            await ctx.reply(
                `✅ Done!\nMovie: ${movie.title}\nThumbnail saved`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('Error setting thumbnail:', error);
            ctx.reply(`Error: ${error.message}`);
        }
    });

    bot.command('delmovie', async (ctx) => {
        if (!isAdmin(ctx)) return;

        const args = ctx.match.trim();
        if (!args) {
            return ctx.reply(
                `🗑️ <b>DELETE MOVIE</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<b>Usage:</b>\n` +
                `<code>/delmovie movie_name</code>\n\n` +
                `<b>Commands:</b>\n` +
                `• <code>/delmovie list</code> - See database list`,
                { parse_mode: 'HTML' }
            );
        }

        if (args.toLowerCase() === 'list') {
            const movies = await Movie.find().select('title').limit(20);
            if (movies.length === 0) {
                return ctx.reply(`No movies in database!`);
            }

            let text = `🗑️ <b>DATABASE LIST</b>\n`;
            text += `━━━━━━━━━ ✦ ━━━━━━━━━\n\n`;
            movies.forEach((m, i) => {
                text += `🎬 <code>${m.title}</code>\n`;
            });
            text += `\n<b>Use:</b> <code>/delmovie movie_name</code>`;

            return ctx.reply(text, { parse_mode: 'HTML' });
        }

        const movieName = cleanMovieName(args);

        try {
            let movie = await Movie.findOne({ title: movieName });

            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: `^${movieName}$`, $options: 'i' } });
            }

            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: movieName, $options: 'i' } });
            }

            if (!movie) {
                return ctx.reply(
                    `Not found: "${args}"\n` +
                    `Type /delmovie list to see all movies`,
                    { parse_mode: 'HTML' }
                );
            }

            const title = movie.title;
            await movie.deleteOne();

            await ctx.reply(
                `✅ Deleted: ${title}`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('Error deleting movie:', error);
            ctx.reply(`Error: ${error.message}`);
        }
    });

    bot.command('rename', async (ctx) => {
        if (!isAdmin(ctx)) return;

        // Format: /rename old_name | new_name
        const args = ctx.match.split('|');
        if (args.length < 2) {
            return ctx.reply(
                `✏️ <b>Rename Filter</b>\n` +
                `━━━━━━━━━ ✦ ━━━━━━━━━\n\n` +
                `<b>Usage:</b>\n` +
                `/rename old_name | new_name\n\n` +
                `<b>Example:</b>\n` +
                `/rename moana | Moana (2016)\n\n` +
                `💡 <i>Tip: Use | to separate old and new names</i>`,
                { parse_mode: 'HTML' }
            );
        }

        const oldNameRaw = args[0].trim();
        const newNameRaw = args[1].trim();

        const oldName = cleanMovieName(oldNameRaw);
        const newName = cleanMovieName(newNameRaw);

        if (!oldName || !newName) {
            return ctx.reply(`❌ Invalid names provided!`);
        }

        if (oldName === newName) {
            return ctx.reply(`❌ Old and new names are the same!`);
        }

        try {
            // Check if new name already exists
            const existingNew = await Movie.findOne({ title: newName });
            if (existingNew) {
                return ctx.reply(`❌ A filter with the name "<b>${newName}</b>" already exists!`, { parse_mode: 'HTML' });
            }

            // Find the movie by old name (with fuzzy matching like /thumb and /delmovie)
            let movie = await Movie.findOne({ title: oldName });
            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: `^${oldName}$`, $options: 'i' } });
            }
            if (!movie) {
                movie = await Movie.findOne({ title: { $regex: oldName, $options: 'i' } });
            }

            if (!movie) {
                return ctx.reply(`❌ Filter "<b>${oldNameRaw}</b>" not found!`, { parse_mode: 'HTML' });
            }

            const actualOldName = movie.title;
            movie.title = newName;
            await movie.save();

            await ctx.reply(
                `✅ <b>Filter Renamed!</b>\n\n` +
                `<b>Old Name:</b> <code>${actualOldName}</code>\n` +
                `<b>New Name:</b> <code>${newName}</code>`,
                { parse_mode: 'HTML' }
            );

            // Log the change
            await sendToLogChannel(ctx.api, `✏️ <b>Filter Renamed</b>\n\n` +
                `👤 Admin: ${ctx.from.first_name}\n` +
                `🎬 Old: ${actualOldName}\n` +
                `🎬 New: ${newName}`);

        } catch (error) {
            console.error('Error renaming movie:', error);
            ctx.reply(`❌ Error: ${error.message}`);
        }
    });
};

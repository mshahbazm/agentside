import { config } from 'dotenv';
config();

import mongoose from 'mongoose';

const CONVERSATION_ID = process.argv[2] || '69d4004c25d7cd2010bbe687';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const doc = await db.collection('scout_conversations').findOne({
    _id: new mongoose.Types.ObjectId(CONVERSATION_ID),
  });

  if (!doc) {
    console.log('Conversation not found:', CONVERSATION_ID);
    process.exit(1);
  }

  console.log('\n=== Conversation ===');
  console.log('id:', doc._id.toString());
  console.log('activeSkills:', doc.activeSkills);
  console.log('originMetadata:', JSON.stringify(doc.originMetadata ?? '<NOT SET>'));
  console.log('has originMetadata key:', 'originMetadata' in doc);
  console.log('createdAt:', doc.createdAt);
  console.log('messageCount:', doc.messages?.length);

  console.log('\n=== Messages ===');
  for (const msg of doc.messages || []) {
    const toolCalls = msg.toolCalls?.map((tc: any) => tc.name) || [];
    const uiBlocks = msg.uiBlocks?.map((b: any) => ({
      type: b.type,
      toolCallId: b.toolCallId,
      hasDeferredAction: !!b.deferredAction,
      deferredToolName: b.deferredAction?.toolName,
    })) || [];
    console.log(`  [${msg.role}] "${(msg.content || '').slice(0, 60)}..." tools=${JSON.stringify(toolCalls)} uiBlocks=${JSON.stringify(uiBlocks)}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

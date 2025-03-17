import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { promisify } from 'util';
import cron from 'node-cron';

// Load environment variables
dotenv.config();

const execPromise = promisify(exec);

// Run pg_dump to create a backup
const createBackup = async (databaseUrl: string) => {
  // Extract database name from URL for naming the file
  const dbName = databaseUrl.split('/').pop() || 'database';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${dbName}-${timestamp}.sql.gz`;
  const filePath = path.join(process.cwd(), 'backups', filename);
  
  // Create backups directory if it doesn't exist
  const backupsDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  console.log(`Creating backup for database ${dbName}...`);
  
  try {
    // Run pg_dump with gzip compression using the full database URL
    const { stdout, stderr } = await execPromise(`${process.env.PG_DUMP_PATH}pg_dump --dbname="${databaseUrl}" -F p | gzip > "${filePath}"`);
    
    // Check if there was any stderr output (which might indicate an error)
    if (stderr && stderr.trim() !== '') {
      console.error('pg_dump stderr:', stderr);
      throw new Error(`pg_dump error: ${stderr}`);
    }
    
    // Check if the file exists and is not empty (min size for a valid gzip file)
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < 20) {
      throw new Error('Backup file is empty or too small, likely failed');
    }
    
    console.log(`Backup created at ${filePath} (${stats.size} bytes)`);
    return { filePath, filename };
  } catch (error) {
    console.error('Error creating backup:', error);
    
    // Check if the file was created but is invalid/empty
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Removed invalid backup file: ${filePath}`);
      } catch (unlinkError) {
        console.error('Failed to remove invalid backup file:', unlinkError);
      }
    }
    
    throw error;
  }
};

// Upload backup to S3
const uploadToS3 = async (filePath: string, filename: string) => {
  const s3Client = new S3Client({
    region: process.env.AWS_S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const fileContent = fs.readFileSync(filePath);
  
  console.log(`Uploading backup to S3 bucket ${process.env.AWS_S3_BUCKET}...`);
  
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: filename,
      Body: fileContent,
      ContentType: 'application/octet-stream',
    });
    
    await s3Client.send(command);
    console.log(`Backup uploaded to S3: ${filename}`);
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
};

// Schedule backup using cron
const scheduleBackup = (cronExpression: string) => {
  console.log(`Scheduling backups with cron pattern: ${cronExpression}`);
  
  cron.schedule(cronExpression, () => {
    console.log(`Executing scheduled backup at ${new Date().toISOString()}`);
    performBackup();
  });
  
  console.log('Backup scheduler is running...');
};

// Main function to execute the backup process
const performBackup = async () => {
  try {
    if (!process.env.BACKUP_DATABASE_URL) {
      throw new Error('BACKUP_DATABASE_URL environment variable is not set');
    }
    
    console.log('Starting database backup process');
    
    const { filePath, filename } = await createBackup(process.env.BACKUP_DATABASE_URL);
    await uploadToS3(filePath, filename);
    
    console.log('Backup process completed successfully');
    
    // Clean up the local file
    fs.unlinkSync(filePath);
    console.log(`Removed local backup file: ${filePath}`);
    
  } catch (error) {
    console.error('Backup process failed:', error);
    process.exit(1);
  }
};

const initialize = () => {
  if (!process.env.BACKUP_DATABASE_URL) {
    console.error('BACKUP_DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  
  const cronInterval = process.env.CRON_JOB_INTERVAL;

  if (cronInterval && cronInterval.trim() !== '') {
    try {
      scheduleBackup(cronInterval);
    } catch (error) {
      console.error('Invalid CRON_JOB_INTERVAL format:', error);
    }
  }

  if (process.env.RUN_ON_STARTUP === 'true') {
    performBackup();
  }
};

initialize();


// Export the functions for use in other scripts
export { performBackup, scheduleBackup, initialize };
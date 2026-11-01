package ai.learnharness.mobile;
import android.content.Context;import java.io.File;import java.io.RandomAccessFile;import java.nio.channels.FileLock;
/** The Activity and engine live in different processes; a Java monitor alone is insufficient. */
final class DocumentGrantStore {
 private static final Object LOCK=new Object();
 interface Operation<T>{T run()throws Exception;}
 static <T>T locked(Context context,Operation<T> operation)throws Exception{synchronized(LOCK){try(RandomAccessFile file=new RandomAccessFile(new File(context.getNoBackupFilesDir(),"document-grants.lock"),"rw");FileLock ignored=file.getChannel().lock()){return operation.run();}}}
}

package ai.learnharness.mobile;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** A separate test-APK provider: the production APK never contains this component. */
public final class QADocumentsProvider extends DocumentsProvider {
 private static final String[] DOC={Document.COLUMN_DOCUMENT_ID,Document.COLUMN_DISPLAY_NAME,Document.COLUMN_MIME_TYPE,Document.COLUMN_FLAGS,Document.COLUMN_SIZE};
 public boolean onCreate(){return true;}
 private File note(String id)throws FileNotFoundException{
  if(!id.equals("existing.md")&&!id.equals("read-only.md")&&(!id.startsWith("subject/")||id.contains("..")))throw new FileNotFoundException();
  File file=new File(getContext().getFilesDir(),id);
  try{if(!file.exists())Files.write(file.toPath(),("---\ntitle: SAF original\n---\n\nA paragraph written by a person.\n").getBytes(StandardCharsets.UTF_8));}catch(Exception e){throw new FileNotFoundException("Fixture unavailable");}return file;
 }
 private void row(MatrixCursor c,String id)throws FileNotFoundException{
  boolean root=id.equals("root")||id.equals("subject");MatrixCursor.RowBuilder r=c.newRow();
  r.add(Document.COLUMN_DOCUMENT_ID,id).add(Document.COLUMN_DISPLAY_NAME,id.equals("root")?"LearnHarness QA":id.equals("subject")?"Chinese subject":new File(id).getName()).add(Document.COLUMN_MIME_TYPE,root?Document.MIME_TYPE_DIR:"text/markdown").add(Document.COLUMN_FLAGS,root?Document.FLAG_DIR_SUPPORTS_CREATE:id.equals("read-only.md")?0:Document.FLAG_SUPPORTS_WRITE).add(Document.COLUMN_SIZE,root?0:note(id).length());
 }
 public Cursor queryRoots(String[] projection){MatrixCursor c=new MatrixCursor(projection==null?new String[]{Root.COLUMN_ROOT_ID,Root.COLUMN_DOCUMENT_ID,Root.COLUMN_TITLE,Root.COLUMN_FLAGS,Root.COLUMN_MIME_TYPES}:projection);c.newRow().add(Root.COLUMN_ROOT_ID,"qa").add(Root.COLUMN_DOCUMENT_ID,"root").add(Root.COLUMN_TITLE,"LearnHarness QA").add(Root.COLUMN_FLAGS,Root.FLAG_LOCAL_ONLY|Root.FLAG_SUPPORTS_CREATE|Root.FLAG_SUPPORTS_IS_CHILD).add(Root.COLUMN_MIME_TYPES,"text/markdown\ntext/plain");return c;}
 public Cursor queryDocument(String id,String[] projection)throws FileNotFoundException{MatrixCursor c=new MatrixCursor(projection==null?DOC:projection);row(c,id);return c;}
 private void subject()throws FileNotFoundException{try{File dir=new File(getContext().getFilesDir(),"subject");dir.mkdirs();String[] names={"HSK 1.md","HSK 1 - Checkpoint.md","HSK 1 - Lesson Log.md"};for(String name:names){File file=new File(dir,name);if(!file.exists())Files.write(file.toPath(),("---\ntags: [chinese]\n---\n\n# 中文\nPractise transport questions.\n").getBytes(StandardCharsets.UTF_8));}}catch(Exception e){throw new FileNotFoundException("Subject fixture unavailable");}}
 public Cursor queryChildDocuments(String parent,String[] projection,String order)throws FileNotFoundException{MatrixCursor c=new MatrixCursor(projection==null?DOC:projection);if(parent.equals("root")){row(c,"existing.md");row(c,"read-only.md");row(c,"subject");}else if(parent.equals("subject")){subject();File[] notes=new File(getContext().getFilesDir(),"subject").listFiles();if(notes!=null)for(File file:notes)if(file.isFile())row(c,"subject/"+file.getName());}return c;}
 @Override public boolean isChildDocument(String parent,String document){return parent.equals("root")&&(document.equals("subject")||document.startsWith("subject/")||document.equals("existing.md")||document.equals("read-only.md"))||parent.equals("subject")&&document.startsWith("subject/");}
 @Override public String createDocument(String parent,String mime,String name)throws FileNotFoundException{if(!parent.equals("subject")||name.contains("/")||name.contains("\\")||!name.endsWith(".md"))throw new FileNotFoundException("Invalid fixture destination");subject();File file=new File(getContext().getFilesDir(),"subject/"+name);try{Files.createFile(file.toPath());return "subject/"+name;}catch(Exception e){throw new FileNotFoundException("Note already exists");}}
 public ParcelFileDescriptor openDocument(String id,String mode,CancellationSignal signal)throws FileNotFoundException{if(id.equals("read-only.md")&&!mode.equals("r"))throw new FileNotFoundException("Read-only provider document");return ParcelFileDescriptor.open(note(id),ParcelFileDescriptor.parseMode(mode));}
}

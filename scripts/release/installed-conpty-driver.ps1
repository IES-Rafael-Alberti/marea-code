param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows ConPTY required' }
[Environment]::CurrentDirectory = (Get-Location).Path
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class MareaInstalledConPty {
 [StructLayout(LayoutKind.Sequential)] struct Coord { public short X,Y; public Coord(short x,short y){X=x;Y=y;} }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
  public short show,reservedSize; public IntPtr reserved2,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Startup startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,int size);
 [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
 [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console,Coord size);
 [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Extended startup,out ProcessInfo process);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static int Run(string exe) {
  IntPtr ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero,pc=IntPtr.Zero,list=IntPtr.Zero;
  ProcessInfo process=new ProcessInfo();
  StreamReader reader=null; FileStream writer=null;
  try {
   Check(CreatePipe(out ir,out iw,IntPtr.Zero,0)); Check(CreatePipe(out or,out ow,IntPtr.Zero,0));
   if(CreatePseudoConsole(new Coord(100,30),ir,ow,0,out pc)!=0)throw new Exception("CreatePseudoConsole failed");
   IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
   list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,1,0,ref size));
   Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20016,pc,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
   Extended startup=new Extended(); startup.startup.cb=Marshal.SizeOf(typeof(Extended)); startup.attributes=list;
   // The parent redirects stdout; null standard handles let ConPTY supply the console.
   startup.startup.flags=0x100; // STARTF_USESTDHANDLES
   Check(CreateProcess(exe,new StringBuilder("\""+exe+"\" --lang en"),IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out process));
   Console.Error.WriteLine("MAREA_CONPTY_PID="+process.pid); Console.Error.Flush();
   CloseHandle(ir); ir=IntPtr.Zero; CloseHandle(ow); ow=IntPtr.Zero;
   reader=new StreamReader(new FileStream(new SafeFileHandle(or,true),FileAccess.Read)); or=IntPtr.Zero;
   writer=new FileStream(new SafeFileHandle(iw,true),FileAccess.Write); iw=IntPtr.Zero;
   var output=Task.Run(()=>{char[] buffer=new char[4096];int count;while((count=reader.Read(buffer,0,buffer.Length))>0){Console.Out.Write(buffer,0,count);Console.Out.Flush();}});
   var input=Task.Run(()=>{byte[] buffer=new byte[4096];int count;var stdin=Console.OpenStandardInput();while((count=stdin.Read(buffer,0,buffer.Length))>0){writer.Write(buffer,0,count);writer.Flush();}});
   if(WaitForSingleObject(process.process,90000)!=0)throw new Exception("ConPTY journey exceeded deadline");
   uint code;Check(GetExitCodeProcess(process.process,out code));
   ClosePseudoConsole(pc);pc=IntPtr.Zero;
   if(!output.Wait(5000))throw new Exception("ConPTY output did not drain");
   return unchecked((int)code);
  } finally {
   if(process.process!=IntPtr.Zero && WaitForSingleObject(process.process,0)!=0){TerminateProcess(process.process,1);WaitForSingleObject(process.process,5000);}
   if(writer!=null)writer.Dispose();
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
   if(pc!=IntPtr.Zero)ClosePseudoConsole(pc);if(reader!=null)reader.Dispose();
   foreach(var handle in new[]{ir,iw,or,ow})if(handle!=IntPtr.Zero)CloseHandle(handle);
   if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}
  }
 }
}
'@
exit [MareaInstalledConPty]::Run((Resolve-Path -LiteralPath $Executable).Path)

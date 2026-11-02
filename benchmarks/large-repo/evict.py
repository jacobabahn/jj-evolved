import os,sys
os.sync()
for d,_,fs in os.walk(sys.argv[1]):
    for f in fs:
        p=os.path.join(d,f)
        if os.path.islink(p): continue
        fd=os.open(p,os.O_RDONLY)
        os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)
        os.close(fd)

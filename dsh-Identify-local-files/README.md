# 主要解决的问题
deepseek 弹窗：仅支持PNG、JPG、WebP、GIF格式的图片

# 解决方案
识别粘贴板的文件是为本地文件
如果是：本地文件
输入框里直接传入  【回形针】文件名（附带文件路径，能不显示就不显示）

如果是：粘贴板图片信息（非文件）
增加临时文件到：C:\Users\viaco\.dsh\.temp
输入框里直接传入  【回形针】文件名（附带文件路径，能不显示就不显示）

如果是：分本地文件，也就是web 别的机器上传的图片
[C:\Users\viaco\.dsh\.temp](增加临时文件到：C:\Users\viaco\.dsh\.temp)

输入框里直接传入  【回形针】文件名（附带文件路径，能不显示就不显示）
、

# [file-plus] 按钮
主要目的是看见插件，实际上不打开这个面板也可以用。输入框的拖入文件和粘贴版功能都是有的。
然后是 点击打开 功能面板
标题:Identify local files
文件拖入区：[
Click here, or drop files to attach
]

文件选择：[Choose files]
粘贴板：[From clipboard image]
功能描述：
[Files are saved to ~/.dsh/.temp/ and inserted as read_local_file
paths. The Agent reads them on demand.]
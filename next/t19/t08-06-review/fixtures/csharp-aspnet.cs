var app = builder.Build();
var reports = app.MapGroup("/reports");
// app.MapGet("/phantom", Phantom);
reports.MapPatch("/{slug}", PatchReport);
app.MapMethods("/batch", new[] { "GET", "POST" }, Batch);

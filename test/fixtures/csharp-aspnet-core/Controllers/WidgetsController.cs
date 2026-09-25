using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class WidgetsController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult GetWidget(int id) => Ok();
}

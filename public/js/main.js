// StudyHub main.js (Node.js version)
// Identical logic to PHP/Flask versions — only the endpoint stays the same shape.

document.addEventListener('DOMContentLoaded', () => {
    const checkboxes = document.querySelectorAll('.topic-checkbox');

    checkboxes.forEach(box => {
        box.addEventListener('change', async () => {
            const topicId = box.getAttribute('data-id');
            const label = box.nextElementSibling;

            try {
                const response = await fetch('/toggle_topic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: topicId })
                });

                const result = await response.json();

                if (result.success) {
                    if (result.is_completed) {
                        label.style.textDecoration = 'line-through';
                        label.style.color = 'var(--text-muted)';
                    } else {
                        label.style.textDecoration = 'none';
                        label.style.color = 'inherit';
                    }
                } else {
                    box.checked = !box.checked;
                    alert('Could not update. Please try again.');
                }
            } catch (err) {
                console.error('Toggle failed:', err);
                box.checked = !box.checked;
            }
        });
    });
});
